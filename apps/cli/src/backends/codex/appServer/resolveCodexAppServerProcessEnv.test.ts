import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { writeConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { withTempDir } from '@/testkit/fs/tempDir';

import { resolveCodexAppServerProcessEnv } from './resolveCodexAppServerProcessEnv';

describe('resolveCodexAppServerProcessEnv', () => {
  it('uses persisted runtime affinity for both Codex homes', async () => {
    await expect(resolveCodexAppServerProcessEnv({
      processEnv: { HOME: '/users/test' },
      affinity: {
        home: 'connectedService',
        homePath: '/materialized/codex-home',
        sqliteHomePath: '/users/test/.codex-state',
      },
    })).resolves.toMatchObject({
      CODEX_HOME: '/materialized/codex-home',
      CODEX_SQLITE_HOME: '/users/test/.codex-state',
    });
  });

  it('recovers the shared SQLite home for legacy descriptors from the materialization manifest', async () => {
    await withTempDir('happier-codex-runtime-env-shared-', async (root) => {
      const codexHome = join(root, 'materialized', 'codex-home');
      await mkdir(codexHome, { recursive: true });
      await writeConnectedServiceStateSharingManifest(codexHome, {
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        lastSyncAtMs: 1,
        configEntries: [],
        stateEntries: [],
        sessionFileMappings: [],
        diagnostics: [],
      });

      await expect(resolveCodexAppServerProcessEnv({
        processEnv: { HOME: root, CODEX_SQLITE_HOME: join(root, 'native-state') },
        affinity: { home: 'connectedService', homePath: codexHome },
      })).resolves.toMatchObject({
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: join(root, 'native-state'),
      });
    });
  });

  it('keeps isolated connected-service SQLite state in the materialized home', async () => {
    await withTempDir('happier-codex-runtime-env-isolated-', async (root) => {
      const codexHome = join(root, 'materialized', 'codex-home');
      await mkdir(codexHome, { recursive: true });
      await writeConnectedServiceStateSharingManifest(codexHome, {
        v: 1,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        lastSyncAtMs: 1,
        configEntries: [],
        stateEntries: [],
        sessionFileMappings: [],
        diagnostics: [],
      });

      await expect(resolveCodexAppServerProcessEnv({
        processEnv: { HOME: root },
        affinity: { home: 'connectedService', homePath: codexHome },
      })).resolves.toMatchObject({
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: codexHome,
      });
    });
  });
});
