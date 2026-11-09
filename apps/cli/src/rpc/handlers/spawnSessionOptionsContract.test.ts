import { describe, expect, it } from 'vitest';
import { buildSessionRoleAssignmentV1, SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1 } from '@happier-dev/protocol';

import {
  isFreshSpawnSessionRoleKnownToAccount,
  mergeSpawnSessionOptions,
  SpawnDaemonSessionRequestSchema,
} from './spawnSessionOptionsContract';
import type { SpawnSessionOptions } from './registerSessionHandlers';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('admits only current roles for fresh creation while retaining legacy roles for existing-session attach', () => {
    const workerSnapshot = {
      v: 1 as const,
      role: 'worker' as const,
      instructions: 'Implement this bounded package.',
      assignmentId: 'assignment-worker',
      assignedAt: 1,
    };
    const parsed = SpawnDaemonSessionRequestSchema.parse({ directory: '/tmp', sessionRoleV1: workerSnapshot });
    expect(parsed.sessionRoleV1).toEqual(workerSnapshot);
    expect(mergeSpawnSessionOptions(parsed as Partial<SpawnSessionOptions>).sessionRoleV1).toEqual(workerSnapshot);
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      sessionRoleV1: { ...workerSnapshot, instructions: '   ' },
    })).toThrow();
    const customSnapshot = {
      v: 1 as const,
      role: 'custom:123e4567-e89b-12d3-a456-426614174000' as const,
      name: 'Architect',
      color: '#123456',
      instructions: 'Design.',
      assignmentId: 'assignment-custom',
      assignedAt: 2,
    };
    expect(SpawnDaemonSessionRequestSchema.parse({ directory: '/tmp', sessionRoleV1: customSnapshot }).sessionRoleV1)
      .toEqual(customSnapshot);
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      sessionRoleV1: { v: 1, role: customSnapshot.role, instructions: 'Missing display snapshot.' },
    })).toThrow();
    expect(() => SpawnDaemonSessionRequestSchema.parse({ directory: '/tmp', sessionRoleV1: { v: 1, role: 'delegate' } })).toThrow();

    const existing = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      existingSessionId: 'sess-legacy',
      sessionRoleV1: { v: 1, role: 'delegate', instructions: 'Retained legacy snapshot.' },
    });
    expect(existing.sessionRoleV1).toEqual({ v: 1, role: 'delegate', instructions: 'Retained legacy snapshot.' });
    expect(() => SpawnDaemonSessionRequestSchema.parse({ directory: '/tmp', sessionRoleV1: { v: 1, role: 'architect' } })).toThrow();
  });

  it('admits the Product Lead template only after its stable custom profile is persisted', () => {
    const snapshot = buildSessionRoleAssignmentV1({
      role: SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id,
      name: SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.name,
      color: SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.color,
      instructions: SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.instructions,
      assignmentId: 'assignment-product-lead',
      assignedAt: 1,
    });

    expect(isFreshSpawnSessionRoleKnownToAccount(snapshot, {})).toBe(false);
    expect(isFreshSpawnSessionRoleKnownToAccount(snapshot, {
      sessionRoleProfilesV1: {
        v: 1,
        instructionsByRole: {},
        customRoles: [SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1],
      },
    })).toBe(true);
  });

  it('preserves exact pending first-input localId bytes and rejects blank identities', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      pendingFirstInput: { text: 'send me', localId: ' spawn-first:opaque ' },
    });

    expect(parsed.pendingFirstInput).toEqual({
      text: 'send me',
      localId: ' spawn-first:opaque ',
    });
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      pendingFirstInput: { text: 'send me', localId: '   ' },
    })).toThrow();
  });

  it('preserves exact nonblank opaque mode and model identifiers', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      agentModeId: ' plan\t',
      modelId: ' model-a\t',
    });

    expect(parsed.agentModeId).toBe(' plan\t');
    expect(parsed.modelId).toBe(' model-a\t');
  });

  it('accepts Windows terminal modes in the terminal payload', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'happier-qa',
    });

    expect(parsed.terminal?.mode).toBe('windows_terminal');
    expect(parsed.windowsRemoteSessionLaunchMode).toBe('windows_terminal');
    expect(parsed.windowsTerminalWindowName).toBe('happier-qa');
  });

  it('maps legacy experimentalCodexAcp requests onto canonical codexBackendMode', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: true,
    });

    expect(parsed.codexBackendMode).toBe('acp');
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('drops legacy experimentalCodexAcp when false', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: false,
    });

    expect(parsed.codexBackendMode).toBeUndefined();
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('preserves canonical codex backend mode from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      codexBackendMode: 'appServer',
    });

    expect(parsed.codexBackendMode).toBe('appServer');
  });

  it('accepts attach metadata identity policy from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
    });

    expect(parsed.attachMetadataIdentityPolicy).toBe('replace_with_runtime_identity');
  });

  it('accepts account settings version hints from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      accountSettingsVersionHint: 42,
    });

    expect(parsed.accountSettingsVersionHint).toBe(42);
  });

  it('accepts connected-services binding timestamps from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 123,
    });

    expect(parsed.connectedServicesUpdatedAt).toBe(123);
  });

  it('accepts approved directory creation through the internal transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      approvedNewDirectoryCreation: true,
    });

    expect(parsed.approvedNewDirectoryCreation).toBe(true);
  });

  it('accepts initial transcript catch-up cursors from resume requests', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      initialTranscriptAfterSeq: 36,
    });

    expect(parsed.initialTranscriptAfterSeq).toBe(36);
  });

  it('accepts fresh user-request execution authorization with an opaque request id', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      initialTranscriptAfterSeq: 36,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: ' message-local-id-1 ',
      },
    });

    expect(parsed.executionAuthorization).toEqual({
      provenance: 'user_request',
      requestId: ' message-local-id-1 ',
    });
  });

  it('accepts multiline initial goal controls from resume requests', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      initialGoal: {
        objective: 'Line one\nLine two',
      },
    });

    expect(parsed.initialGoal).toEqual({
      objective: 'Line one\nLine two',
    });
  });

  it('rejects malformed account settings version hints', () => {
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      accountSettingsVersionHint: -1,
    })).toThrow();

    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      accountSettingsVersionHint: 1.5,
    })).toThrow();
  });

  it('preserves account settings version hints through spawn option merging', () => {
    const options = {
      directory: '/tmp',
      accountSettingsVersionHint: 7,
    } as Partial<SpawnSessionOptions>;

    expect(mergeSpawnSessionOptions(options)).toMatchObject({
      accountSettingsVersionHint: 7,
    });
  });

  it('preserves connected-services binding timestamps through spawn option merging', () => {
    const options = {
      directory: '/tmp',
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 456,
    } as Partial<SpawnSessionOptions>;

    expect(mergeSpawnSessionOptions(options)).toMatchObject({
      connectedServicesUpdatedAt: 456,
    });
  });

  it('preserves materialization diagnostics through spawn option merging', () => {
    const options = {
      directory: '/tmp',
      materializationDiagnostics: [{
        code: 'state_sharing_degraded',
        providerId: 'claude',
        serviceId: 'anthropic',
        requestedStateMode: 'shared',
        effectiveStateMode: 'isolated',
        reason: 'provider_state_unavailable',
      }],
    } as Partial<SpawnSessionOptions>;

    expect(mergeSpawnSessionOptions(options)).toMatchObject({
      materializationDiagnostics: options.materializationDiagnostics,
    });
  });
});

describe('spawn ingress (visible agents)', () => {
  it('declares the run link and creation origin so the ingress never strips them', () => {
    const executionRunLinkV1 = { v: 1, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0 };
    const sessionOriginV1 = { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'a1' } };
    const parsed = SpawnDaemonSessionRequestSchema.parse({ directory: '/tmp', executionRunLinkV1, sessionOriginV1 }) as Record<string, unknown>;
    expect(parsed.executionRunLinkV1).toEqual(executionRunLinkV1);
    expect(parsed.sessionOriginV1).toEqual(sessionOriginV1);
    expect(SpawnDaemonSessionRequestSchema.safeParse({ directory: '/tmp', executionRunLinkV1: { v: 1, runId: 'r' } }).success).toBe(false);
  });
});
