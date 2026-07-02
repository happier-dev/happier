import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCodexAppServerProcessEnv,
  writeFakeCodexAppServerThreadListScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';

import { resolveCodexExternalSessionAppServerMetadata } from './resolveCodexExternalSessionAppServerMetadata';

describe('resolveCodexExternalSessionAppServerMetadata', () => {
  it('returns the newest app-server preview metadata and trims title and cwd fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-app-server-metadata-'));
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });

    const sessionId = 'remote_preview';
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      initializeName: 'fake',
      nonArchivedThreads: [{
        id: sessionId,
        name: '  App server preview  ',
        updatedAt: 1736000100,
        cwd: '  /repo/from-app-server  ',
      }],
    });

    const metadata = await resolveCodexExternalSessionAppServerMetadata({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      remoteSessionId: sessionId,
      env: createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome }),
    });

    expect(metadata).toEqual({
      updatedAtMs: 1_736_000_100_000,
      previewText: 'App server preview',
      workingDirectory: '/repo/from-app-server',
    });
  });

});
