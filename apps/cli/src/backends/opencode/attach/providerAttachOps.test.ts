import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openCodeProviderAttachOps } from './providerAttachOps';

describe('openCodeProviderAttachOps', () => {
  const previousManagedServerStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;

  afterEach(() => {
    if (previousManagedServerStatePath === undefined) {
      delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
    } else {
      process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = previousManagedServerStatePath;
    }
    vi.unstubAllGlobals();
  });

  it('classifies same-machine OpenCode sessions as local attach', async () => {
    await expect(openCodeProviderAttachOps.evaluateEligibility({
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      },
      currentMachineId: 'machine-local',
      sessionMachineId: 'machine-local',
      hasLocalAttachmentInfo: false,
    })).resolves.toMatchObject({
      eligible: true,
      scope: 'local',
    });
  });

  it('treats a local attachment marker as authoritative local ownership', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-opencode-provider-attach-'));
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = join(stateDir, 'managed-server.json');
    await writeFile(process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH, JSON.stringify({
      baseUrl: 'http://127.0.0.1:4096/',
      pid: 12345,
      startedAtMs: Date.now(),
      status: 'ready',
    }));

    await expect(openCodeProviderAttachOps.evaluateEligibility({
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
      },
      currentMachineId: 'machine-after-reauth',
      sessionMachineId: 'machine-before-reauth',
      hasLocalAttachmentInfo: true,
    })).resolves.toMatchObject({
      eligible: true,
      scope: 'local',
    });
  });

  it('probes remote OpenCode reachability via the provider server health endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openCodeProviderAttachOps.probeReachability?.({
      metadata: {
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'https://remote.example.test/base/',
        opencodeServerBaseUrlExplicit: true,
      },
    })).resolves.toMatchObject({
      reachable: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example.test/global/health',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });
});
