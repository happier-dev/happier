import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCodexAppServerProcessEnv,
  writeFakeCodexAppServerThreadListScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';

import {
  mapCodexExternalSessionAppServerPreviewToMessage,
  resolveCodexExternalSessionAppServerMetadata,
} from './resolveCodexExternalSessionAppServerMetadata';

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

  it('maps app-server preview metadata into a direct transcript message', () => {
    expect(
      mapCodexExternalSessionAppServerPreviewToMessage({
        remoteSessionId: 'remote_preview',
        metadata: {
          updatedAtMs: 1_736_000_100_000,
          previewText: '  App server preview  ',
          workingDirectory: '/repo/from-app-server',
        },
      }),
    ).toEqual({
      id: 'codex:app-server:remote_preview:1736000100000',
      localId: 'codex:app-server:remote_preview:1736000100000',
      createdAtMs: 1_736_000_100_000,
      raw: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'message',
            message: 'App server preview',
          },
        },
      },
    });
  });
});
