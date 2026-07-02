import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { writeConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { resolveSessionConnectedServiceSwitchContinuity } from './startDaemonSessionControlRuntime';

const bindings: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected',
      selection: 'group',
      profileId: 'codex1',
      groupId: 'happier',
    },
  },
};

describe('resolveSessionConnectedServiceSwitchContinuity', () => {
  it('preserves provider continuity diagnostics through the dev startup adapter path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-continuity-'));
    try {
      await writeConnectedServiceStateSharingManifest(root, {
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        lastSyncAtMs: 1_000,
        configEntries: [],
        stateEntries: ['sessions/--tmp-project--'],
        sessionFileMappings: [],
        diagnostics: [],
      });

      await expect(resolveSessionConnectedServiceSwitchContinuity({
        sessionId: 'session-pi',
        agentId: 'pi',
        serviceId: 'openai-codex',
        previousBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai-codex',
          profileId: 'codex1',
          groupId: 'happier',
        },
        nextBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai-codex',
          profileId: 'codex1',
          groupId: 'happier',
        },
        fromBindingsRaw: bindings,
        toBindings: bindings,
        accountSettings: null,
        connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_pi_shared', createdAt: 1_000 },
        vendorResumeId: '019e7327-46cc-7dca-bb14-8473727db321',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: join(root, 'native', 'missing-session.jsonl'),
      })).resolves.toMatchObject({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          materializationIdentityId: 'csm_pi_shared',
          targetMaterializedRoot: root,
          vendorResumeId: '019e7327-46cc-7dca-bb14-8473727db321',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: join(root, 'native', 'missing-session.jsonl'),
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
