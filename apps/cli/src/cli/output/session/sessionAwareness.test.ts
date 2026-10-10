import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';

import {
  deriveAccountMachineKeyFromRecoverySecret,
  sealEncryptedDataKeyEnvelopeV1,
  SessionAwarenessProjectionV1Schema,
  type AccountRecipientEnvelopeReadiness,
} from '@happier-dev/protocol';
import { encodeBase64 } from '@/api/encryption';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  createAccountEncryptionCurrentnessFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import { buildCliSessionAwarenessInputV1, projectCliSessionAwarenessV1 } from '@/cli/output/session/sessionAwareness';

const NOW_MS = 1_700_000_000_000;

const tokenOnlyCredentials = { token: 'token-only', encryption: null } as const;

function project(row: Parameters<typeof createSessionRecordFixture>[0], nowMs = NOW_MS) {
  return projectCliSessionAwarenessV1({
    credentials: tokenOnlyCredentials,
    accountEncryption: createAccountEncryptionCurrentnessFixture(),
    row: createSessionRecordFixture(row),
    nowMs,
  });
}

describe('projectCliSessionAwarenessV1', () => {
  it('retains public workflow origin and reporting relationships when private content cannot be opened', () => {
    const awareness = project({ id: 'locked-step', encryptionMode: 'e2ee',
      metadata: 'unavailable', origin: { kind: 'run_step', runId: 'workflow-run' },
      reportsTo: { sessionId: 'lead' },
      reports: { total: 2, working: 1, needsYou: 0, stalled: 1 },
    });
    expect(awareness.origin).toEqual({ kind: 'run_step', runId: 'workflow-run' });
    expect(awareness.reportsTo).toEqual({ sessionId: 'lead' });
    expect(awareness.reports).toEqual({ total: 2, working: 1, needsYou: 0, stalled: 1 });
    expect(awareness).not.toHaveProperty('lineage');
    expect(SessionAwarenessProjectionV1Schema.safeParse(awareness).success).toBe(true);
  });
  it('exposes the persisted V2 Session presence while keeping its own foreground turn', () => {
    const awareness = project({
      id: 'session-working',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: 'Release prep', updatedAt: 1 }, path: '/repo' }),
      active: true,
      activeAt: NOW_MS - 1_000,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: NOW_MS - 1_000,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
    } as never);

    expect(awareness).toMatchObject({
      v: 1,
      sessionId: 'session-working',
      title: 'Release prep',
      lifecycle: 'active',
      runtime: 'working',
      freshness: 'live',
      operational: { primary: 'working' },
      encryption: 'plain',
      availability: 'complete',
      workspace: { path: '/repo' },
    });
    expect(SessionAwarenessProjectionV1Schema.safeParse(awareness).success).toBe(true);
  });

  it('reports the persisted offline Session presence', () => {
    const awareness = project({
      id: 'session-offline',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: 'Build repair', updatedAt: 1 } }),
      active: false,
      activeAt: NOW_MS - 3_600_000,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
    } as never);

    expect(awareness.runtime).toBe('offline');
    expect(awareness.freshness).toBe('offline');
    expect(awareness.operational.reasons).toContain('runtime_offline');
  });

  it('normalizes presence from the current row without turning stale evidence into live idle', () => {
    const row = createSessionRecordFixture({ id: 'presence', encryptionMode: 'plain', metadata: '{}',
      updatedAt: NOW_MS, active: true, activeAt: NOW_MS, latestTurnStatus: null,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
    const params = { credentials: tokenOnlyCredentials, accountEncryption: createAccountEncryptionCurrentnessFixture(), row, nowMs: NOW_MS };
    expect(buildCliSessionAwarenessInputV1(params).runtime.presence).toBe('online');
    expect(projectCliSessionAwarenessV1(params)).toMatchObject({ runtime: 'idle', freshness: 'live', availability: 'complete' });
    row.active = false;
    expect(buildCliSessionAwarenessInputV1(params).runtime.presence).toBe('offline');
    expect(projectCliSessionAwarenessV1(params).runtime).toBe('offline');
    row.active = true;
    row.activeAt = NOW_MS - 3_600_000;
    expect(projectCliSessionAwarenessV1(params).freshness).toBe('stale');
  });

  it('keeps background provider activity distinct from a foreground turn', () => {
    const awareness = project({
      id: 'session-background',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: 'Indexing', updatedAt: 1 } }),
      active: true,
      activeAt: NOW_MS - 1_000,
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: NOW_MS - 1_000,
      runtimeActivityRevision: 2,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
    } as never);

    expect(awareness.runtime).toBe('background_active');
    expect(awareness.operational.reasons).toContain('background_activity');
    expect(awareness.operational.reasons).not.toContain('working');
  });

  it('reports unknown content availability when token-only credentials have no opening evidence', () => {
    const awareness = project({
      id: 'session-locked',
      encryptionMode: 'e2ee',
      metadata: 'retained-ciphertext',
      dataEncryptionKey: 'sealed-key',
      active: true,
      activeAt: NOW_MS - 1_000,
    } as never);

    expect(awareness.encryption).toBe('unknown');
    expect(awareness.availability).toBe('locked');
    expect(awareness.operational.reasons).toContain('content_locked');
    expect(awareness).not.toHaveProperty('title');
    expect(awareness).not.toHaveProperty('workspace');
  });

  it('does not reinterpret a legacy encrypted row with no mode as plain', () => {
    const awareness = project({
      id: 'legacy-encrypted',
      metadata: 'retained-ciphertext',
      dataEncryptionKey: 'sealed-key',
    });
    expect(awareness.encryption).toBe('unknown');
    expect(awareness.availability).toBe('locked');
  });

  it('includes the canonical paused work and already-authorized workspace facts', () => {
    const awareness = project({
      id: 'session-work', encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-one', path: '/repo',
        forkV1: { v: 1, parentSessionId: 'parent-one', parentCutoffSeqInclusive: 3, createdAtMs: NOW_MS, strategy: 'native' },
        sessionWorkStateV1: { v: 1, backendId: 'codex', updatedAt: NOW_MS,
          items: [{ id: 'task-one', kind: 'task', origin: 'happier', status: 'paused',
            title: 'Review migration', updatedAt: NOW_MS }] },
      }),
    });
    expect(awareness.currentWork).toMatchObject({ itemId: 'task-one', status: 'paused', title: 'Review migration' });
    expect(awareness.workspace).toEqual({ machineId: 'machine-one', path: '/repo' });
    expect(awareness.lineage).toEqual({ relation: 'fork', sourceSessionId: 'parent-one' });
  });

  it('uses an authorized name when the summary is empty', () => {
    const awareness = project({
      id: 'named-session', encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: '  ', updatedAt: 1 }, name: ' Named session ' }),
    });
    expect(awareness.title).toBe('Named session');
  });

  it('retains an observed archive without a turn-status field', () => {
    const awareness = project({
      id: 'archived-session', encryptionMode: 'plain', metadata: '{}',
      archivedAt: NOW_MS - 1, latestTurnStatus: undefined,
    });
    expect(awareness.lifecycle).toBe('archived');
    expect(awareness.operational.reasons).toContain('archived');
  });

  it('reports unreadable Plain metadata as unavailable work currentness rather than nothing to do', () => {
    // The wire field is required, so an empty or unparsable string is admitted and
    // decodes to no metadata at all: the work state is unknown, not absent.
    const unreadable = project({
      id: 'session-metadata-unreadable', encryptionMode: 'plain', metadata: '',
      active: true, activeAt: NOW_MS, latestTurnStatus: null,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: NOW_MS,
    } as never);
    expect(unreadable.currentWork).toBeUndefined();
    expect(unreadable.availability).toBe('partial');

    // Readable metadata that simply carries no work state stays complete.
    const readable = project({
      id: 'session-metadata-empty', encryptionMode: 'plain', metadata: '{}',
      active: true, activeAt: NOW_MS, latestTurnStatus: null,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: NOW_MS,
    } as never);
    expect(readable.currentWork).toBeUndefined();
    expect(readable.availability).toBe('complete');
  });

  it('keeps absent lifecycle evidence incomplete even when pending evidence is available', () => {
    const awareness = project({
      id: 'lifecycle-unavailable', encryptionMode: 'plain', metadata: '{}',
      active: true, activeAt: NOW_MS, latestTurnStatus: undefined,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    });
    expect(awareness.lifecycle).toBe('unknown');
    expect(awareness.availability).toBe('partial');
  });

  it('keeps partial pending evidence incomplete when only one request counter is present', () => {
    const awareness = project({
      id: 'pending-partial', encryptionMode: 'plain', metadata: '{}',
      active: true, activeAt: NOW_MS,
      pendingPermissionRequestCount: 0,
    });
    expect(awareness.availability).toBe('partial');
  });

  it('keeps a published ready sequence as lifecycle evidence when the row carries no live facts', () => {
    const published = project({
      id: 'session-published-ready', encryptionMode: 'plain', metadata: '{}',
      latestTurnStatus: undefined, archivedAt: null,
      latestReadyEventSeq: 10, latestReadyEventAt: NOW_MS - 1_000,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    } as never);
    expect(published.operational.primary).toBe('ready');

    const withoutSequence = project({
      id: 'session-no-ready-sequence', encryptionMode: 'plain', metadata: '{}',
      latestTurnStatus: undefined, archivedAt: null,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    } as never);
    expect(withoutSequence.operational.primary).not.toBe('ready');
    expect(withoutSequence.availability).toBe('partial');
  });

  it('forwards authorized terminal control serviceability so an unservable host suppresses liveness', () => {
    const unservable = project({
      id: 'session-unservable-terminal', encryptionMode: 'plain',
      metadata: JSON.stringify({
        terminal: {
          mode: 'tmux',
          controlServiceabilityV1: { v: 1, state: 'recoverable_unservable', observedAt: NOW_MS - 1_000 },
        },
      }),
      active: true, activeAt: NOW_MS - 1_000, latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: NOW_MS - 1_000,
      pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: NOW_MS - 1_000,
    } as never);
    expect(unservable.runtime).toBe('offline');
    expect(unservable.operational.primary).not.toBe('permission_required');

    // Genuinely absent evidence stays unknown rather than asserting a servable host.
    const withoutEvidence = project({
      id: 'session-no-terminal-evidence', encryptionMode: 'plain',
      metadata: JSON.stringify({ terminal: { mode: 'tmux' } }),
      active: true, activeAt: NOW_MS - 1_000, latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: NOW_MS - 1_000,
      pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: NOW_MS - 1_000,
    } as never);
    expect(withoutEvidence.runtime).toBe('waiting');
    expect(withoutEvidence.operational.primary).toBe('permission_required');

    // A malformed or foreign-version envelope is no evidence, never a fabricated state.
    const malformed = project({
      id: 'session-malformed-terminal-evidence', encryptionMode: 'plain',
      metadata: JSON.stringify({
        terminal: { mode: 'tmux', controlServiceabilityV1: { v: 2, state: 'recoverable_unservable' } },
      }),
      active: true, activeAt: NOW_MS - 1_000, latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: NOW_MS - 1_000,
      pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: NOW_MS - 1_000,
    } as never);
    expect(malformed.runtime).toBe('waiting');
  });

  it('reports incomplete rather than safe when a producer projected no pending state', () => {
    const withPending = project({
      id: 'session-pending-known',
      latestTurnStatus: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: 'Approval', updatedAt: 1 } }),
      active: true,
      activeAt: NOW_MS - 1_000,
      pendingPermissionRequestCount: 1,
      pendingUserActionRequestCount: 0,
      pendingRequestObservedAt: NOW_MS - 1_000,
    } as never);
    expect(withPending.operational.primary).toBe('permission_required');
    expect(withPending.availability).toBe('complete');

    const withoutPending = project({
      id: 'session-pending-unknown',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: 'Approval', updatedAt: 1 } }),
      active: true,
      activeAt: NOW_MS - 1_000,
    } as never);
    expect(withoutPending.availability).toBe('partial');
    expect(withoutPending.operational.reasons).not.toContain('permission_required');
  });
});

/**
 * Content availability comes from the incumbent decryption owner, never from this normalizer.
 * These cases drive real envelopes and real ciphertext through `readSessionPresentationContent`
 * so each state is one the content owner can actually attest — the CLI used to collapse every
 * one of them into `unknown`, which told a caller "we did not look" when the truth was "your
 * access has not arrived yet" or "this content is damaged".
 */
describe('projectCliSessionAwarenessV1 content availability', () => {
  const secret = new Uint8Array(32).fill(7);
  const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
  const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  const credentials = { token: 'test', encryption: { type: 'dataKey', machineKey, publicKey } } as const;
  const dek = new Uint8Array(32).fill(19);
  const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: dek,
    recipientPublicKey: publicKey,
    randomBytes: (length) => new Uint8Array(length).fill(11),
  }));
  const metadata = encryptSessionPayload({
    ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' },
    payload: { summary: { text: 'Security review', updatedAt: 1 }, path: '/private/repo' },
  });

  function projectE2ee(params: Readonly<{
    row?: Record<string, unknown>;
    recipientEnvelopeReadiness?: AccountRecipientEnvelopeReadiness;
  }>) {
    return projectCliSessionAwarenessV1({
      credentials,
      accountEncryption: createAccountEncryptionCurrentnessFixture({
        mode: 'e2ee',
        ...(params.recipientEnvelopeReadiness ? { recipientEnvelopeReadiness: params.recipientEnvelopeReadiness } : {}),
      }),
      row: createSessionRecordFixture({
        id: 'e2ee-session',
        encryptionMode: 'e2ee',
        metadata,
        dataEncryptionKey,
        active: true,
        activeAt: NOW_MS - 1_000,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: NOW_MS - 1_000,
        ...params.row,
      } as never),
      nowMs: NOW_MS,
    });
  }

  it('reports ready and discloses private content only after the owner actually opened it', () => {
    const awareness = projectE2ee({});
    expect(awareness.encryption).toBe('ready');
    expect(awareness.availability).toBe('complete');
    expect(awareness.title).toBe('Security review');
    expect(awareness.workspace).toEqual({ path: '/private/repo' });
    expect(awareness.operational.reasons).not.toContain('content_locked');
  });

  it.each([
    [{ status: 'available' }, 'access_pending'],
    [{ status: 'unavailable', reason: 'encryption_setup_required' }, 'setup_required'],
    [{ status: 'unavailable', reason: 'plain_account' }, 'setup_required'],
    [{ status: 'unavailable', reason: 'encryption_inconsistent' }, 'repair_needed'],
  ] as const)('carries the Account recipient readiness %j into awareness as %s', (readiness, encryption) => {
    const awareness = projectE2ee({
      recipientEnvelopeReadiness: readiness,
      row: { dataEncryptionKey: null, share: { accessLevel: 'view', canApprovePermissions: false } },
    });
    expect(awareness.encryption).toBe(encryption);
    expect(awareness.availability).toBe('locked');
    expect(awareness.operational.reasons).toContain('content_locked');
    expect(awareness).not.toHaveProperty('title');
    expect(awareness).not.toHaveProperty('workspace');
  });

  it('reports repair for a present malformed envelope rather than pending access', () => {
    const awareness = projectE2ee({
      recipientEnvelopeReadiness: { status: 'available' },
      row: { dataEncryptionKey: 'not-base64' },
    });
    expect(awareness.encryption).toBe('repair_needed');
    expect(awareness.availability).toBe('locked');
  });

  it('reports unavailable content when an opened key cannot authenticate the stored bytes', () => {
    const awareness = projectE2ee({
      recipientEnvelopeReadiness: { status: 'available' },
      row: {
        metadata: encryptSessionPayload({
          ctx: { encryptionKey: new Uint8Array(32).fill(47), encryptionVariant: 'dataKey' },
          payload: { summary: { text: 'Security review', updatedAt: 1 } },
        }),
      },
    });
    expect(awareness.encryption).toBe('content_unavailable');
    expect(awareness.availability).toBe('locked');
    expect(awareness).not.toHaveProperty('title');
  });

});
