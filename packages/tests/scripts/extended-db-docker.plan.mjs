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

function resolveCliAppWorkspaceName() {
  try {
    const pkgPath = resolve(REPO_ROOT, 'apps', 'cli', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const json = JSON.parse(raw);
    const name = typeof json?.name === 'string' ? json.name.trim() : '';
    return name || '@happier-dev/cli';
  } catch {
    return '@happier-dev/cli';
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

export function buildExtendedDbCommandPlan({ db, mode, databaseUrl, contractFile = undefined, containerId = undefined }) {
  if (db !== 'postgres' && db !== 'mysql') {
    throw new Error(`Unsupported db: ${String(db)}`);
  }
  if (
    mode !== 'e2e'
    && mode !== 'contract'
    && mode !== 'extended'
    && mode !== 'session-system-record-upgrade'
  ) {
    throw new Error(`Unsupported mode: ${String(mode)}`);
  }
  if (!databaseUrl || !String(databaseUrl).trim()) {
    throw new Error('Missing databaseUrl');
  }
  if (contractFile !== undefined && (mode === 'e2e' || typeof contractFile !== 'string' || !contractFile.trim() || contractFile.startsWith('-'))) {
    throw new Error('A contract file filter requires contract or extended mode and a test file path');
  }

  /** @type {Array<{kind: string, command: string, args: string[], env: Record<string, string>}>} */
  const steps = [];

  const prebuildCliSharedStep = {
    kind: 'prebuild-cli-shared',
    command: 'pnpm',
    args: ['--silent', '--filter', resolveCliAppWorkspaceName(), 'run', 'build:shared'],
    env: { CI: '1' },
  };

  const prebuildCliStep = {
    kind: 'prebuild-cli',
    command: 'pnpm',
    args: ['--silent', '--filter', resolveCliAppWorkspaceName(), 'run', 'build'],
    env: { CI: '1' },
  };

  const e2eStep = {
    kind: 'e2e',
    command: 'pnpm',
    args: ['run', 'test:e2e'],
    env: {
      HAPPIER_E2E_DB_PROVIDER: db,
      DATABASE_URL: String(databaseUrl),
    },
  };

  const providerEnv = {
    HAPPIER_DB_PROVIDER: db,
    DATABASE_URL: String(databaseUrl),
    ...(db === 'postgres'
      ? { HAPPIER_TEST_POSTGRES_DATABASE_URL: String(databaseUrl) }
      : { HAPPIER_TEST_MYSQL_DATABASE_URL: String(databaseUrl) }),
  };

  const migrateStep =
    db === 'mysql'
      ? {
          kind: 'migrate',
          command: 'pnpm',
          args: ['--silent', '--filter', resolveServerAppWorkspaceName(), 'run', 'migrate:mysql:deploy'],
          env: {
            ...providerEnv,
            HAPPIER_DB_MIGRATION_APPROVAL: '20260729102000_add_voice_conversation_grant_provenance',
          },
        }
      : {
          kind: 'migrate',
          command: 'pnpm',
          args: ['--silent', '--filter', resolveServerAppWorkspaceName(), 'run', 'migrate:full:deploy'],
          env: providerEnv,
        };

  const contractStep = {
    kind: 'contract',
    command: 'pnpm',
    args: ['--filter', resolveServerAppWorkspaceName(), 'run', 'test:db-contract', ...(contractFile === undefined ? [] : [contractFile])],
    env: {
      ...providerEnv,
      ...(containerId === undefined ? {} : {
        HAPPIER_DB_CONTRACT_CONTAINER_ID: containerId,
        HAPPIER_DB_CONTRACT_TEMPLATE_URL: databaseUrl,
      }),
    },
  };

  const mysqlVoiceIdentityUpgradeContractStep = {
    kind: 'mysql-voice-identity-upgrade-contract',
    command: 'pnpm',
    args: ['--silent', '--filter', resolveServerAppWorkspaceName(), 'run', 'test:mysql-voice-identity-upgrade-contract'],
    env: {
      HAPPIER_DB_PROVIDER: 'mysql',
      DATABASE_URL: String(databaseUrl),
    },
  };

  if (mode === 'session-system-record-upgrade') {
    const fixtureStep = (operation) => ({
      kind: `session-system-record-upgrade-${operation}`,
      command: 'pnpm',
      args: [
        '--silent',
        '--filter',
        resolveServerAppWorkspaceName(),
        'run',
        'test:session-system-record-upgrade-fixture',
        operation,
      ],
      env: providerEnv,
    });
    const canonicalMigration = {
      ...migrateStep,
      env: migrateStep.env,
    };
    return [
      fixtureStep('seed'),
      { ...canonicalMigration, kind: 'session-system-record-migrate-first' },
      { ...canonicalMigration, kind: 'session-system-record-migrate-second' },
      fixtureStep('verify'),
      {
        ...contractStep,
        kind: 'session-system-record-board-contract',
        args: [
          '--filter',
          resolveServerAppWorkspaceName(),
          'run',
          'test:db-contract',
          'sources/app/session/systemRecords/sessionSystemRecords.dbcontract.spec.ts',
        ],
      },
    ];
  }

  if (mode === 'e2e') return [prebuildCliSharedStep, prebuildCliStep, e2eStep];
  if (mode === 'contract') {
    return db === 'mysql'
      ? [mysqlVoiceIdentityUpgradeContractStep, migrateStep, contractStep]
      : [migrateStep, contractStep];
  }
  return [prebuildCliSharedStep, prebuildCliStep, e2eStep, migrateStep, contractStep];
}
