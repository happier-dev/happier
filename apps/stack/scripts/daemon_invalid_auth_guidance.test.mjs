import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveDevTargetControllerReauthHint } from './daemon.mjs';

test('derived dev-target invalid-auth guidance reauthenticates the controller when its copied credential is also stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-dev-target-auth-guidance-'));
  try {
    const storageDir = join(root, 'stack-state');
    const cliHomeDir = join(root, 'cli');
    const controllerStack = 'repo-dev-a1cc5e0671';
    const targetStack = 'dev-target-mac-host-dfcbfd6a94d90609';
    const controllerCliHome = cliHomeDir;
    const controllerCredential = join(
      controllerCliHome,
      'servers',
      `stack_${controllerStack}__id_default`,
      'access.key',
    );
    const targetCredential = join(
      cliHomeDir,
      'servers',
      `stack_${targetStack}__id_default`,
      'access.key',
    );
    mkdirSync(join(storageDir, controllerStack), { recursive: true });
    mkdirSync(join(storageDir, targetStack), { recursive: true });
    mkdirSync(join(controllerCliHome, 'servers', `stack_${controllerStack}__id_default`), { recursive: true });
    mkdirSync(join(cliHomeDir, 'servers', `stack_${targetStack}__id_default`), { recursive: true });
    writeFileSync(
      join(storageDir, controllerStack, 'env'),
      `HAPPIER_STACK_CLI_HOME_DIR=${controllerCliHome}\n`,
      'utf8',
    );
    writeFileSync(join(storageDir, targetStack, 'env'), `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}\n`, 'utf8');
    writeFileSync(controllerCredential, '{"token":"same-stale-token"}\n', 'utf8');
    writeFileSync(targetCredential, '{"token":"same-stale-token"}\n', 'utf8');

    assert.equal(
      resolveDevTargetControllerReauthHint({
        stackName: targetStack,
        cliIdentity: 'default',
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:53288',
        env: {
          HAPPIER_DEV_TARGET_EXECUTION: '1',
          HAPPIER_STACK_STORAGE_DIR: storageDir,
          HAPPIER_STACK_STACK: targetStack,
          HAPPIER_STACK_AUTH_SEED_FROM: controllerStack,
          HAPPIER_ACTIVE_SERVER_ID: `stack_${targetStack}__id_default`,
        },
      }),
      `hstack stack auth ${controllerStack} login --force`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
