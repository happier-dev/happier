import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');

function resolveServerAppWorkspaceName() {
  try {
    const pkgPath = resolve(REPO_ROOT, 'apps', 'server', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const json = JSON.parse(raw);
    const name = typeof json?.name === 'string' ? json.name.trim() : '';
    return name || '@happier-dev/server';
  } catch {
    return '@happier-dev/server';
  }
}

export function sanitizeDockerEnv(env) {
  const out = { ...(env ?? {}) };
  // Allow docker client to negotiate with the daemon. On some machines, DOCKER_API_VERSION is pinned
  // and can cause `docker run` to fail with “server supports a different API version”.
  delete out.DOCKER_API_VERSION;
  return out;
}

export function buildDbContainerPlan({ db, name }) {
  if (db !== 'postgres' && db !== 'mysql') {
    throw new Error(`Unsupported db: ${String(db)}`);
  }

  const baseName = name && String(name).trim() ? String(name).trim() : `happier-test-${db}-${randomUUID().slice(0, 8)}`;

  if (db === 'postgres') {
    return {
      db,
      name: baseName,
      image: 'postgres:17',
      env: {
        POSTGRES_DB: 'happier',
        POSTGRES_USER: 'happier',
        POSTGRES_PASSWORD: 'happier',
      },
      ports: { containerPort: 5432, publishSpec: '127.0.0.1::5432' },
      healthCmd: 'pg_isready -U happier -d happier',
    };
  }

  return {
    db,
    name: baseName,
    image: 'mysql:8.0',
    env: {
      MYSQL_ROOT_PASSWORD: 'happier',
      MYSQL_DATABASE: 'happier',
    },
    ports: { containerPort: 3306, publishSpec: '127.0.0.1::3306' },
    // Use CMD-SHELL so $MYSQL_ROOT_PASSWORD is expanded by the container shell.
    healthCmd: 'mysqladmin ping -h 127.0.0.1 -u root -p$MYSQL_ROOT_PASSWORD',
  };
}

export function parseDockerPortLine(line) {
  const raw = String(line ?? '').trim();
  const match = raw.match(/^(.+):(\d+)$/);
  if (!match) throw new Error(`Failed to parse docker port line: ${raw}`);
  return { host: match[1], port: Number(match[2]) };
}

function normalizeDockerHostForUrl(host) {
  const raw = String(host ?? '').trim();
  if (!raw) return '127.0.0.1';
  // `docker port` can return wildcard bindings; connecting to those is typically wrong.
  if (raw === '0.0.0.0' || raw === '::' || raw === '[::]') return '127.0.0.1';
  // URL hostnames with `:` must be wrapped in brackets.
  if (raw.includes(':') && !raw.startsWith('[')) return `[${raw}]`;
  return raw;
}

export function buildDatabaseUrlForContainer({ db, host, port }) {
  const h = normalizeDockerHostForUrl(host);
  const p = Number(port);
  if (db === 'postgres') {
    return `postgresql://happier:happier@${h}:${p}/happier?sslmode=disable`;
  }
  if (db === 'mysql') {
    return `mysql://root:happier@${h}:${p}/happier`;
  }
  throw new Error(`Unsupported db: ${String(db)}`);
}

export function buildExtendedDbCommandPlan({ db, mode, databaseUrl }) {
  if (db !== 'postgres' && db !== 'mysql') {
    throw new Error(`Unsupported db: ${String(db)}`);
  }
  if (mode !== 'e2e' && mode !== 'contract' && mode !== 'extended') {
    throw new Error(`Unsupported mode: ${String(mode)}`);
  }
  if (!databaseUrl || !String(databaseUrl).trim()) {
    throw new Error('Missing databaseUrl');
  }

  /** @type {Array<{kind: string, command: string, args: string[], env: Record<string, string>}>} */
  const steps = [];

  const e2eStep = {
    kind: 'e2e',
    command: 'yarn',
    args: ['test:e2e'],
    env: {
      HAPPIER_E2E_DB_PROVIDER: db,
      DATABASE_URL: String(databaseUrl),
    },
  };

  const migrateStep =
    db === 'mysql'
      ? {
          kind: 'migrate',
          command: 'yarn',
          args: ['-s', 'workspace', resolveServerAppWorkspaceName(), 'migrate:mysql:deploy'],
          env: { DATABASE_URL: String(databaseUrl) },
        }
      : {
          kind: 'migrate',
          command: 'yarn',
          args: ['-s', 'workspace', resolveServerAppWorkspaceName(), 'prisma', 'migrate', 'deploy'],
          env: { DATABASE_URL: String(databaseUrl) },
        };

  const contractStep = {
    kind: 'contract',
    command: 'yarn',
    args: ['workspace', resolveServerAppWorkspaceName(), 'test:db-contract'],
    env: {
      HAPPIER_DB_PROVIDER: db,
      DATABASE_URL: String(databaseUrl),
    },
  };

  if (mode === 'e2e') return [e2eStep];
  if (mode === 'contract') return [migrateStep, contractStep];
  return [e2eStep, migrateStep, contractStep];
}
