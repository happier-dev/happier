import { join } from 'node:path';

export function readBooleanEnvFlag(env, name, fallback = false) {
  const raw = env && typeof env === 'object' ? env[name] : undefined;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  return fallback;
}

export function sanitizeDefinedEnv(env = {}) {
  const cleanEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value == null) continue;
    cleanEnv[key] = String(value);
  }
  return cleanEnv;
}

const STACK_TEST_RUNNER_ENV_DENY_KEYS = new Set([
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_DAEMON_SERVICE_LABEL',
  'HAPPIER_DAEMON_STARTUP_SOURCE',
  'HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT',
  'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT',
  'HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED',
  'HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH',
  'HAPPIER_HOME_DIR',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
]);
const STACK_TEST_ISOLATED_ROOT_MARKER = 'HAPPIER_STACK_TEST_ISOLATED_ROOT';
const STACK_TEST_REPO_DIR_MARKER = 'HAPPIER_STACK_TEST_REPO_DIR';

export function sanitizeStackTestRunnerEnv(env = {}, { isolatedStackRoot = '', repoDir = '' } = {}) {
  const cleanEnv = sanitizeDefinedEnv(env);
  const inheritedIsolatedStackRoot = String(cleanEnv[STACK_TEST_ISOLATED_ROOT_MARKER] ?? '').trim();
  const inheritedRepoDir = String(cleanEnv[STACK_TEST_REPO_DIR_MARKER] ?? '').trim();
  for (const key of Object.keys(cleanEnv)) {
    if (STACK_TEST_RUNNER_ENV_DENY_KEYS.has(key) || key.startsWith('HAPPIER_STACK_')) {
      delete cleanEnv[key];
    }
  }
  const root = String(isolatedStackRoot ?? '').trim() || inheritedIsolatedStackRoot;
  if (root) {
    cleanEnv[STACK_TEST_ISOLATED_ROOT_MARKER] = root;
    cleanEnv.HAPPIER_STACK_CANONICAL_HOME_DIR = join(root, 'canonical-home');
    cleanEnv.HAPPIER_STACK_HOME_DIR = join(root, 'home');
    cleanEnv.HAPPIER_STACK_STORAGE_DIR = join(root, 'stacks');
    cleanEnv.HAPPIER_STACK_WORKSPACE_DIR = join(root, 'workspace');
    cleanEnv.HAPPIER_STACK_RUNTIME_DIR = join(root, 'runtime');
  }
  const repo = String(repoDir ?? '').trim() || inheritedRepoDir;
  if (repo) {
    cleanEnv[STACK_TEST_REPO_DIR_MARKER] = repo;
    cleanEnv.HAPPIER_STACK_REPO_DIR = repo;
  }
  return cleanEnv;
}
