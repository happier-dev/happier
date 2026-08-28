#!/bin/sh
set -eu

server_binary="${1:-}"
if [ "$#" -gt 1 ]; then
  echo "[entrypoint] Usage: run-server.sh [packaged-server-binary]"
  exit 1
fi
if [ -n "$server_binary" ] && [ ! -x "$server_binary" ]; then
  echo "[entrypoint] Packaged server binary is not executable: $server_binary"
  exit 1
fi

is_false() {
  case "$(printf "%s" "${1:-}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" in
    0|false|no|off) return 0 ;;
    *) return 1 ;;
  esac
}

migrations_enabled=1
if is_false "${RUN_MIGRATIONS:-1}" || is_false "${HAPPIER_STACK_PRISMA_MIGRATE:-1}"; then
  migrations_enabled=0
fi

provider="$(printf "%s" "${HAPPIER_DB_PROVIDER:-${HAPPY_DB_PROVIDER:-postgres}}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
flavor="$(printf "%s" "${HAPPIER_SERVER_FLAVOR:-${HAPPY_SERVER_FLAVOR:-full}}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
start_script="start"
if [ "$flavor" = "light" ]; then
  start_script="start:light"
fi
schema="prisma/schema.prisma"
should_migrate="1"
case "$provider" in
  ""|"postgres"|"postgresql") provider="postgres"; schema="prisma/schema.prisma" ;;
  "mysql") schema="prisma/mysql/schema.prisma" ;;
  "sqlite")
    if [ -n "$server_binary" ]; then
      should_migrate="0"
    fi
    ;;
  "pglite") schema="prisma/schema.prisma" ;;
  *)
    echo "[entrypoint] Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER: $provider"
    exit 1
    ;;
esac

export HAPPIER_DB_PROVIDER="$provider"
export HAPPY_DB_PROVIDER="$provider"
export HAPPIER_SERVER_FLAVOR="$flavor"
export HAPPY_SERVER_FLAVOR="$flavor"

if [ "$provider" = "sqlite" ]; then
  if [ "$migrations_enabled" = "0" ]; then
    sqlite_auto_migrate="0"
  else
    sqlite_auto_migrate="1"
  fi
  export HAPPIER_SQLITE_AUTO_MIGRATE="$sqlite_auto_migrate"
  export HAPPY_SQLITE_AUTO_MIGRATE="$sqlite_auto_migrate"

  if [ -z "$server_binary" ]; then
    sqlite_migrations_dir="$(printf "%s" "${HAPPIER_SQLITE_MIGRATIONS_DIR:-${HAPPY_SQLITE_MIGRATIONS_DIR:-}}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -z "$sqlite_migrations_dir" ]; then
      if [ -d "$(pwd)/apps/server/prisma/sqlite/migrations" ]; then
        sqlite_migrations_dir="$(pwd)/apps/server/prisma/sqlite/migrations"
      else
        sqlite_migrations_dir="$(pwd)/prisma/sqlite/migrations"
      fi
    fi
    export HAPPIER_SQLITE_MIGRATIONS_DIR="$sqlite_migrations_dir"
    export HAPPY_SQLITE_MIGRATIONS_DIR="$sqlite_migrations_dir"
  fi
fi

if [ "$should_migrate" = "1" ] && [ "$migrations_enabled" = "1" ]; then
  attempts="${MIGRATIONS_MAX_ATTEMPTS:-30}"
  delay="${MIGRATIONS_RETRY_DELAY_SECONDS:-2}"

  i=1
  while [ "$i" -le "$attempts" ]; do
    if [ "$provider" = "pglite" ]; then
      migration_command="migrate:light:deploy"
    elif [ "$provider" = "sqlite" ]; then
      migration_command="migrate:sqlite:deploy"
    else
      migration_command="prisma migrate deploy --schema $schema"
    fi
    echo "[entrypoint] Running ${migration_command} (${provider}) (attempt $i/$attempts)..."

    if [ -n "$server_binary" ]; then
      migration_binary="$(dirname "$server_binary")/happier-server-migrate"
      if [ ! -x "$migration_binary" ]; then
        echo "[entrypoint] Packaged migration binary is not executable: $migration_binary"
        exit 1
      fi
      out="$("$migration_binary" 2>&1)" && status=0 || status=$?
    else
      if [ "$provider" = "pglite" ]; then
        out="$(yarn --cwd apps/server migrate:light:deploy 2>&1)" && status=0 || status=$?
      elif [ "$provider" = "sqlite" ]; then
        out="$(yarn --cwd apps/server migrate:sqlite:deploy 2>&1)" && status=0 || status=$?
      else
        out="$(yarn --cwd apps/server prisma migrate deploy --schema "$schema" 2>&1)" && status=0 || status=$?
      fi
    fi
    if [ "$status" -eq 0 ]; then
      printf "%s\n" "$out"
      break
    fi
    printf "%s\n" "$out"

    if [ "$provider" = "postgres" ] || [ "$provider" = "postgresql" ]; then
      if echo "$out" | grep -q "Timed out trying to acquire a postgres advisory lock"; then
      echo "[entrypoint] Advisory lock timeout; retrying in ${delay}s..."
      sleep "$delay"
      i=$((i + 1))
      continue
      fi
    fi

    if echo "$out" | grep -Eq "P1001|Can't reach database server|connection refused|ECONNREFUSED"; then
      echo "[entrypoint] Database not reachable yet; retrying in ${delay}s..."
      sleep "$delay"
      i=$((i + 1))
      continue
    fi

    echo "[entrypoint] Migration failed."
    exit "$status"
  done

  if [ "$i" -gt "$attempts" ]; then
    echo "[entrypoint] Migrations failed after ${attempts} attempts."
    exit 1
  fi
fi

if [ -n "$server_binary" ]; then
  exec "$server_binary"
fi
exec yarn --cwd apps/server "$start_script"
