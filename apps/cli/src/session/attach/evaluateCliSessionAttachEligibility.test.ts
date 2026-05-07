import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { evaluateCliSessionAttachEligibility } from './evaluateCliSessionAttachEligibility';

const credentials: Credentials = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

const previousManagedServerStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;

afterEach(() => {
  if (previousManagedServerStatePath === undefined) {
    delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
    return;
  }
  process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = previousManagedServerStatePath;
});

describe('evaluateCliSessionAttachEligibility', () => {
  it('rejects sessions from a different physical host even when synced tmux metadata exists', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_remote_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        flavor: 'claude',
        host: 'office-imac',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-1' },
        },
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      currentMachineHost: 'leeroy-mbp',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'not_current_machine',
    });
  });

  it('accepts a local terminal marker even when the session machine identity changed', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_marker_after_machine_rotation_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-before-reauth',
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-after-reauth',
      currentMachineHost: 'leeroy-mbp',
      localAttachmentInfo: {
        version: 1,
        sessionId: 'sid_local_marker_after_machine_rotation_1',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-1' },
        },
        updatedAt: Date.now(),
      },
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'terminal_host',
      agentId: 'claude',
      attachScope: 'local',
      plan: expect.objectContaining({ type: 'tmux', target: 'happy:session-1' }),
    });
  });

  it('rejects same-host synced tmux metadata when the machine identity differs and no local marker exists', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_same_host_synced_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-from-ui',
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-2' },
        },
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-from-cli',
      currentMachineHost: 'leeroy-mbp.local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'not_current_machine',
    });
  });

  it('rejects same-host synced tmux metadata when the current machine id is unavailable and no local marker exists', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_same_host_missing_current_machine_id_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-from-ui',
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-3' },
        },
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: null,
      currentMachineHost: 'leeroy-mbp.local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'current_machine_unknown',
    });
  });

  it('rejects same-host synced tmux metadata when the session machine id is unavailable and no local marker exists', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_same_host_missing_session_machine_id_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-4' },
        },
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-from-cli',
      currentMachineHost: 'leeroy-mbp.local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'session_machine_unknown',
    });
  });

  it('requires a local attachment marker for tmux-backed terminal attach even when same-host synced metadata exists', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'claude',
        host: 'leeroy-mbp',
        path: '/tmp/workspace',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-1' },
        },
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      currentMachineHost: 'leeroy-mbp.local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: false,
      reasonCode: 'missing_local_attach_state',
    });
  });

  it('accepts provider-attach sessions on the current machine without local terminal attachment state', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });
  });

  it('accepts same-machine OpenCode sessions when the managed server state provides the local server URL', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-opencode-attach-'));
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = join(stateDir, 'managed-server.json');
    await writeFile(process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH, JSON.stringify({
      baseUrl: 'http://127.0.0.1:4096/',
      pid: 12345,
      startedAtMs: Date.now(),
      status: 'ready',
    }));

    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_managed_state_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });
  });

  it('treats a local attachment marker as authoritative local ownership for OpenCode provider attach', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-opencode-attach-local-marker-'));
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = join(stateDir, 'managed-server.json');
    await writeFile(process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH, JSON.stringify({
      baseUrl: 'http://127.0.0.1:4096/',
      pid: 12345,
      startedAtMs: Date.now(),
      status: 'ready',
    }));

    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_local_marker_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-before-reauth',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-after-reauth',
      localAttachmentInfo: {
        version: 1,
        sessionId: 'sid_local_opencode_local_marker_1',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:opencode-1' },
        },
        updatedAt: Date.now(),
      },
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'local',
    });
  });

  it('accepts provider-attach sessions as remote when machine ownership is missing', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_local_opencode_missing_machine_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'remote',
    });
  });

  it('accepts provider-attach sessions as remote when they belong to another machine', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'sid_remote_opencode_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        flavor: 'opencode',
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'https://remote.example.test/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });

    await expect(evaluateCliSessionAttachEligibility({
      credentials,
      rawSession,
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      agentId: 'opencode',
      attachScope: 'remote',
    });
  });
});
