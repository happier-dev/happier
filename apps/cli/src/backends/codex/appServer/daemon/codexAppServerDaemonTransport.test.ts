import { stat } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { withFakeCodexAppServerWebSocket, createCodexAppServerProcessEnv } from '../testkit/fakeCodexAppServer';
import { withTempDir } from '@/testkit/fs/tempDir';

import { isCodexThreadLoadedInAppServerDaemon } from './codexAppServerDaemonTransport';

describe('codexAppServerDaemonTransport', () => {
  it('reports only loaded thread ids when fixture files have a long directory path', async () => {
    const prefix = 'happier-codex-daemon-transport-'.repeat(process.platform === 'win32' ? 1 : 5);
    await withTempDir(prefix, async (root) => {
      await withFakeCodexAppServerWebSocket({ dir: root, loadedThreadIds: ['loaded-thread'] }, async ({ socketPath, proxyPath }) => {
        // The advertised Unix path must name the bound socket, not a truncated OS pathname.
        if (process.platform !== 'win32') expect((await stat(socketPath)).isSocket()).toBe(true);
        const processEnv = createCodexAppServerProcessEnv(proxyPath);

        await expect(isCodexThreadLoadedInAppServerDaemon({
          cwd: root,
          processEnv,
          threadId: 'loaded-thread',
        })).resolves.toBe(true);
        await expect(isCodexThreadLoadedInAppServerDaemon({
          cwd: root,
          processEnv,
          threadId: 'idle-thread',
        })).resolves.toBe(false);
      });
    }, process.platform === 'win32' ? undefined : '/tmp');
  });
});
