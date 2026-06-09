# 🚀 Для своих — Сервер

## Что это
Node.js + Socket.IO + PostgreSQL бэкенд для мессенджера «Для своих».

## Возможности
- ✅ Регистрация и авторизация (JWT)
- ✅ Реальные чаты через WebSocket
- ✅ Хранение сообщений в PostgreSQL
- ✅ Загрузка фото и видео
- ✅ Push-уведомления (Web Push)
- ✅ Голосовые сообщения
- ✅ Секретные чаты
- ✅ Индикатор «печатает...»
- ✅ Онлайн-статусы

---

## Деплой на Render.com

### Шаг 1 — Загрузи код на GitHub
Создай новый репозиторий `dlya-svoikh-server` и загрузи все файлы.

### Шаг 2 — Зайди на render.com
- Нажми **New +** → **Web Service**
- Подключи GitHub репозиторий `dlya-svoikh-server`
- Render сам найдёт `render.yaml` и всё настроит

### Шаг 3 — Переменные окружения
Render автоматически добавит `DATABASE_URL` и `JWT_SECRET`.
Вручную добавь:
```
CLIENT_URL = https://prideman2022.github.io
```

### Шаг 4 — Получи URL сервера
После деплоя Render даст URL вида:
```
https://dlya-svoikh-server.onrender.com
```

### Шаг 5 — Обнови index.html
Вставь этот URL в переменную `SERVER_URL` в `index.html`.

---

## Push-уведомления (опционально)

Сгенерируй VAPID ключи:
```bash
npx web-push generate-vapid-keys
```

Добавь в переменные окружения на Render:
```
VAPID_PUBLIC_KEY  = <публичный ключ>
VAPID_PRIVATE_KEY = <приватный ключ>
VAPID_EMAIL       = твой@email.com
```

---

## API эндпоинты

### Auth
| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/register` | Регистрация |
| POST | `/api/login` | Вход |
| GET  | `/api/me` | Мой профиль |
| PUT  | `/api/me` | Обновить профиль |

### Пользователи
| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/users/search?q=имя` | Поиск |

### Чаты
| Метод | URL | Описание |
|-------|-----|----------|
| GET    | `/api/chats` | Список чатов |
| POST   | `/api/chats/direct` | Создать/найти диалог |
| POST   | `/api/chats/group` | Создать группу |
| DELETE | `/api/chats/:id` | Удалить чат |

### Сообщения
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/api/chats/:id/messages` | Получить сообщения |
| POST | `/api/upload` | Загрузить файл |

## Socket.IO события

| Событие | Описание |
|---------|----------|
| `message:send` | Отправить сообщение |
| `message:new`  | Новое сообщение получено |
| `typing:start` | Начал печатать |
| `typing:stop`  | Перестал печатать |
| `message:react`| Реакция |
| `message:delete`| Удалить |
| `call:start`   | Начать звонок |
| `user:online`  | Пользователь онлайн |
| `user:offline` | Пользователь офлайн |
