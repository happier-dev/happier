import { describe, expect, it } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  projectLegacySessionAccessCapabilitiesV1,
  SessionOwnerMetadataV1Schema,
  SessionSummarySchema,
} from '@happier-dev/protocol';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  summarizeSessionRow as summarizeSessionRowOwner,
} from '@/cli/output/session/sessionSummary';

function summarizeSessionRow(
  params: Omit<
    Parameters<typeof summarizeSessionRowOwner>[0],
    'accountEncryptionMode'
  > & Partial<Pick<
    Parameters<typeof summarizeSessionRowOwner>[0],
    'accountEncryptionMode'
  >>,
) {
  return summarizeSessionRowOwner({
    ...params,
    accountEncryptionMode: params.accountEncryptionMode ?? 'plain',
  });
}

describe('summarizeSessionRow', () => {
  const credentials = {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(5),
    },
  } satisfies {
    token: string;
    encryption: {
      type: 'legacy';
      secret: Uint8Array;
    };
  };

  it('adds system session fields when metadata includes systemSessionV1', () => {
    const metadata = encodeBase64(encryptLegacy({
      tag: 'MySession',
      systemSessionV1: {
        v: 1,
        key: 'voice_carrier',
        hidden: true,
      },
    }, credentials.encryption.secret));

    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-system',
        metadata,
        metadataVersion: 1,
      }),
    });

    expect(session.isSystem).toBe(true);
    expect(session.systemPurpose).toBe('voice_carrier');
  });

  it('omits system session fields when metadata is missing systemSessionV1', () => {
    const metadata = encodeBase64(encryptLegacy({ tag: 'MySession' }, credentials.encryption.secret));
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-user',
        metadata,
        metadataVersion: 1,
      }),
    });

    expect(session.isSystem).toBeUndefined();
    expect(session.systemPurpose).toBeUndefined();
  });

  it('summarizes shared and owner fields from a sealed layout-v1 owner envelope', () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/worktree',
        host: 'private-host',
        machineId: 'machine-target',
      },
      runtime: {
        permissionMode: 'acceptEdits',
        permissionModeUpdatedAt: 123,
      },
      nativeSession: {
        tag: 'private-tag',
      },
      system: {
        systemSessionV1: {
          v: 1,
          key: 'voice_carrier',
          hidden: true,
        },
      },
    });
    const ownerMetadataEnvelope =
      createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
    const row = createSessionRecordFixture({
      id: 'session-layout-v1-owner',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        summary: {
          text: 'Recipient-safe title',
          updatedAt: 10,
        },
      }),
      ownerMetadata: ownerMetadataEnvelope,
    });

    expect(summarizeSessionRow({ credentials, row })).toMatchObject({
      title: 'Recipient-safe title',
      tag: 'private-tag',
      path: '/private/worktree',
      host: 'private-host',
      machineId: 'machine-target',
      permissionMode: 'safe-yolo',
      isSystem: true,
      systemPurpose: 'voice_carrier',
    });

    const unreadableOwnerSummary = summarizeSessionRow({
      credentials,
      row: {
        ...row,
        ownerMetadata: {
          t: 'encrypted',
          c: 'not-owner-ciphertext',
        },
      },
    });
    expect(unreadableOwnerSummary.title).toBe('Recipient-safe title');
    for (const key of ['tag', 'path', 'host', 'machineId', 'permissionMode', 'isSystem', 'systemPurpose'] as const) {
      expect(unreadableOwnerSummary).not.toHaveProperty(key);
    }

    const futureLayoutSummary = summarizeSessionRow({
      credentials,
      row: {
        ...row,
        metadataLayoutVersion: 2,
      } as any,
    });
    for (const key of ['title', 'tag', 'path', 'host', 'machineId', 'permissionMode', 'isSystem', 'systemPurpose'] as const) {
      expect(futureLayoutSummary).not.toHaveProperty(key);
    }
  });

  it('preserves every operational fact the public Session summary schema supports', () => {
    const row = createSessionRecordFixture({
      id: 'session-operational',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ tag: 'Operational' }),
      latestTurnId: 'turn-7',
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1_700_000_000_100,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'agent_process_exit',
        source: 'agent_process_exit',
        occurredAt: 1_700_000_000_000,
      },
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 1_700_000_000_050,
      runtimeActivityRevision: 4,
      rollbackEligibleTurnStarts: [12, 34],
    } as never);

    const summary = summarizeSessionRow({ credentials, row });

    expect(summary).toMatchObject({
      latestTurnId: 'turn-7',
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1_700_000_000_100,
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 2,
      runtimeActivityObservedAt: 1_700_000_000_050,
      runtimeActivityRevision: 4,
      rollbackEligibleTurnStarts: [12, 34],
    });
    expect(summary.lastRuntimeIssue).toMatchObject({ code: 'agent_process_exit' });
    expect(SessionSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('omits operational facts an older producer did not project rather than inventing them', () => {
    const summary = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-no-operational-facts',
        encryptionMode: 'plain',
        metadata: JSON.stringify({ tag: 'Bare' }),
      }),
    });

    for (const key of [
      'latestTurnStatus',
      'lastRuntimeIssue',
      'runtimeActivityState',
      'rollbackEligibleTurnStarts',
      'pendingActivationAuthorization',
    ] as const) {
      expect(summary).not.toHaveProperty(key);
    }
  });

  it('preserves collective effective access without fabricating a direct share', () => {
    const effectiveAccess = {
      v: 1 as const,
      level: 'view' as const,
      sources: [{
        kind: 'team' as const,
        teamId: 'team-1',
        requiredByTeamPolicy: false,
      }],
      capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
      audienceContext: { kind: 'team' as const, teamId: 'team-1' },
      primaryTeamId: 'team-1',
    };
    const summary = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-team-access',
        encryptionMode: 'plain',
        metadata: JSON.stringify({ summary: { text: 'Team session' } }),
        effectiveAccess,
      }),
    });

    expect(summary.effectiveAccess).toEqual(effectiveAccess);
    expect(summary).not.toHaveProperty('share');
    expect(SessionSummarySchema.parse(summary)).toEqual(summary);
  });

  it('is tolerant of malformed metadata', () => {
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({
        id: 'session-malformed',
        metadata: 'not-base64',
      }),
    });

    expect(session.isSystem).toBeUndefined();
    expect(session.systemPurpose).toBeUndefined();
    expect(session).not.toHaveProperty('machineId');
    expect(session).not.toHaveProperty('permissionMode');
  });

  it.each([
    ['read-only', 'read-only'],
    ['safe-yolo', 'safe-yolo'],
    ['yolo', 'yolo'],
    ['plan', 'plan'],
    ['default', 'default'],
    ['acceptEdits', 'safe-yolo'],
    ['bypassPermissions', 'yolo'],
  ])('projects the Machine binding and canonical permission intent from retained metadata: %s', (permissionMode, expectedMode) => {
    const metadata = encodeBase64(encryptLegacy({
      machineId: ' machine-target ',
      permissionMode,
      permissionModeUpdatedAt: 123,
    }, credentials.encryption.secret));
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({ id: 'session-binding', metadata }),
    });

    expect(session.machineId).toBe('machine-target');
    expect(session.permissionMode).toBe(expectedMode);
  });

  it.each([
    {},
    { machineId: '  ', permissionMode: 'unknown' },
    { machineId: 123, permissionMode: null },
    { host: 'machine-target', path: '/workspace' },
  ])('omits summary authority when metadata does not supply it: %j', (value) => {
    const metadata = encodeBase64(encryptLegacy(value, credentials.encryption.secret));
    const session = summarizeSessionRow({
      credentials,
      row: createSessionRecordFixture({ id: 'session-missing-authority', metadata }),
    });

    expect(session).not.toHaveProperty('machineId');
    expect(session).not.toHaveProperty('permissionMode');
  });

  it('summarizes a plain Session with token-only credentials without fabricating encryption material', () => {
    const session = summarizeSessionRow({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      row: createSessionRecordFixture({
        id: 'session-plain-token-only',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          tag: 'PlainSession',
          summary: {
            text: 'Plain session',
            updatedAt: 10,
          },
          path: '/worktree',
          host: 'plain-host',
          machineId: 'machine-target',
          permissionMode: 'default',
        }),
      }),
    });

    expect(session).toMatchObject({
      id: 'session-plain-token-only',
      encryptionMode: 'plain',
      encryption: null,
      tag: 'PlainSession',
      title: 'Plain session',
      path: '/worktree',
      host: 'plain-host',
      machineId: 'machine-target',
      permissionMode: 'default',
    });
  });

  it('keeps a retained E2EE Session visible when token-only credentials cannot open its metadata', () => {
    const session = summarizeSessionRow({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      row: createSessionRecordFixture({
        id: 'session-e2ee-token-only',
        encryptionMode: 'e2ee',
        metadata: 'retained-ciphertext',
      }),
    });

    expect(session).toMatchObject({
      id: 'session-e2ee-token-only',
      encryptionMode: 'e2ee',
      encryption: null,
    });
    expect(session.title).toBeUndefined();
    expect(session.path).toBeUndefined();
    expect(session).not.toHaveProperty('machineId');
    expect(session).not.toHaveProperty('permissionMode');
  });
});
