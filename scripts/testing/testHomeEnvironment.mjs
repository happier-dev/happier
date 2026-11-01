import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createTestTempDirectory } from './process/temporaryDirectories.mjs';

// Shared by config-time admission and worker setup. No application imports:
// configuration and its persistence readers must only see disposable roots.
export function createTestHomeEnvironment() {
  const temporary = createTestTempDirectory('happier-test-home-');
  const env = resolveTestHomeEnvironment(temporary.root);
  mkdirSync(env.HAPPIER_HOME_DIR, { recursive: true });
  mkdirSync(env.HOME, { recursive: true });
  return { env, cleanup: temporary.cleanup };
}

// Playwright finds its installed browsers relative to HOME, which isolation replaces. Keep the
// location the runner installed into (`playwright install`); an inherited isolated Home already
// carries it from the first resolution.
function resolvePlaywrightBrowsersPath() {
  const inherited = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (inherited) return inherited;
  const userHome = process.env.HOME || process.env.USERPROFILE;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || (userHome && join(userHome, 'AppData', 'Local'));
    return localAppData ? join(localAppData, 'ms-playwright') : undefined;
  }
  return userHome ? join(userHome, process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright') : undefined;
}

export function resolveTestHomeEnvironment(root) {
  const playwrightBrowsersPath = resolvePlaywrightBrowsersPath();
  const env = {
    ...(playwrightBrowsersPath ? { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath } : {}),
    HAPPIER_TEST_HOME_ROOT: root,
    HOME: join(root, 'user'),
    USERPROFILE: join(root, 'user'),
    HAPPIER_HOME_DIR: join(root, 'cli'),
    HAPPIER_STACK_CLI_HOME_DIR: join(root, 'cli'),
    HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(root, 'cli'),
    HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: join(root, 'user'),
    HAPPIER_SELF_HOST_INSTALL_ROOT: join(root, 'self-host-install'),
    HAPPIER_SELF_HOST_CONFIG_DIR: join(root, 'self-host'),
    HAPPIER_SELF_HOST_LOG_DIR: join(root, 'self-host-logs'),
    HAPPIER_CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDE_CONFIG_DIR: '',
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  return env;
}

export function applyTestHomeEnvironment(env, root) {
  Object.assign(env, resolveTestHomeEnvironment(root));
  // Config-time env guards an early import, but a worker's safe default user
  // Home must not shadow a fixture's explicit Home via an optional override.
  for (const key of ['HAPPIER_SELF_HOST_INSTALL_ROOT', 'HAPPIER_SELF_HOST_CONFIG_DIR', 'HAPPIER_SELF_HOST_LOG_DIR']) {
    delete env[key];
  }
}

export function assertTestHomePath(homeDir, root = process.env.HAPPIER_TEST_HOME_ROOT) {
  const inside = root && relative(root, homeDir);
  if (!root || inside === '' || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) {
    throw new Error('Test configuration escaped its disposable Happier Home root');
  }
}

export function installTestHomeEnvironment() {
  // Test workers cannot borrow a daemon's selected server/Stack identity.
  // Cases that exercise these inputs set them explicitly after setup.
  for (const key of Object.keys(process.env)) {
    if (key === 'HAPPIER_ACTIVE_SERVER_ID' || key === 'HAPPIER_SERVER_ID'
      || key === 'HAPPIER_LOCAL_SERVER_URL' || key === 'HAPPIER_PUBLIC_SERVER_URL'
      || key === 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID' || key.startsWith('HAPPIER_STACK_')) {
      delete process.env[key];
    }
  }
  const home = createTestHomeEnvironment();
  applyTestHomeEnvironment(process.env, home.env.HAPPIER_TEST_HOME_ROOT);
  assertTestHomePath(process.env.HAPPIER_HOME_DIR);
  return home;
}
