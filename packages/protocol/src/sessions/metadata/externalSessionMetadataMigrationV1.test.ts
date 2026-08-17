import { describe, expect, it } from 'vitest';

import {
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
} from './sessionMetadataEnvelopesV1.js';

describe('External Sessions layout-0 classification', () => {
  it('splits the current externalSessionV1 link into public presentation and owner-only authority', () => {
    const metadata = {
      externalSessionV1: {
        v: 1 as const,
        agentId: 'codex',
        machineId: 'machine-private-current',
        remoteSessionId: 'native-private-current',
        source: {
          kind: 'codexHome',
          home: 'user',
        },
        qualifiedIdentity: {
          v: 1 as const,
          agent: {
            pluginId: 'com.happier.codex',
            localId: 'codex',
          },
          source: {
            kind: 'codexHome',
            contractVersion: 1 as const,
          },
        },
        linkData: {
          rolloutFile: 'sessions/private-rollout.jsonl',
        },
        linkedAtMs: 1,
        followPolicyV1: {
          v: 1 as const,
          policy: 'background_follow' as const,
          updatedAtMs: 2,
        },
      },
    };

    const shared = projectSessionSharedMetadataV1({ metadata });
    const owner = createSessionOwnerMetadataV1({ metadata });

    expect(shared).toEqual({
      v: 1,
      agentPresentation: { agentId: 'codex' },
    });
    expect(owner).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        nativeSession: {
          externalSessionV1: metadata.externalSessionV1,
        },
      },
    });
    expect(JSON.stringify(shared)).not.toMatch(
      /machine-private-current|native-private-current|private-rollout|background_follow/,
    );
  });

  it('splits the released directSessionV1 link without promoting predecessor provider vocabulary', () => {
    const metadata = {
      directSessionV1: {
        v: 1 as const,
        providerId: 'claude',
        machineId: 'machine-private-predecessor',
        remoteSessionId: 'native-private-predecessor',
        source: {
          kind: 'claudeConfig',
          configDir: '/private/claude-config',
        },
        linkedAtMs: 3,
        followPolicyV1: {
          v: 1 as const,
          policy: 'attached_only' as const,
          updatedAtMs: 4,
        },
      },
    };

    const shared = projectSessionSharedMetadataV1({ metadata });
    const owner = createSessionOwnerMetadataV1({ metadata });

    expect(shared).toEqual({
      v: 1,
      agentPresentation: { agentId: 'claude' },
    });
    expect(owner).toEqual({
      ok: true,
      ownerMetadata: {
        v: 1,
        nativeSession: {
          externalSessionV1: {
            v: 1,
            agentId: 'claude',
            machineId: 'machine-private-predecessor',
            remoteSessionId: 'native-private-predecessor',
            source: {
              kind: 'claudeConfig',
              configDir: '/private/claude-config',
            },
            linkedAtMs: 3,
            followPolicyV1: {
              v: 1,
              policy: 'attached_only',
              updatedAtMs: 4,
            },
          },
        },
      },
    });
    expect(JSON.stringify(shared)).not.toMatch(
      /providerId|machine-private-predecessor|native-private-predecessor|private\/claude-config|attached_only/,
    );
  });
});
