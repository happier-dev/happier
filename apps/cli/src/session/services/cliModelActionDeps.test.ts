import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

import { createCliSessionModelActionDeps } from './cliModelActionDeps';
// Collect the real lazy service before cases; shared-host module loading is not a turn deadline.
import './setSessionModel';

const { fetchSessionById, fetchAccountEncryptionCurrentness, callSessionRpc } = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  callSessionRpc: vi.fn(),
}));

// Home HTTP and Session RPC are network boundaries; selection and result owners stay real.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness,
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc }));

describe('CLI model transition recovery', () => {
  const sessionId = 'cmvy5lpvq002gmcuzfxyyduax';
  const activeSelection = ProviderBoundModelRefSchema.parse({
    agentTargetKey: 'agent:happier.agent.codex/codex',
    providerConnectionId: 'pc_work',
    modelId: 'gpt-6-luna',
  });
  const requestedSelection = { ...activeSelection, modelId: 'shared-model' };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchAccountEncryptionCurrentness.mockResolvedValue({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
    fetchSessionById.mockResolvedValue({
      id: sessionId, active: true, activeAt: 1, metadataVersion: 1,
      encryptionMode: 'plain', metadataLayoutVersion: 0,
      // Retained layout-0 record, matching setSessionModel's existing transport fixture.
      metadata: JSON.stringify({
        flavor: 'codex',
        modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: activeSelection },
      }),
    });
  });

  it('retains the unavailable model owner phase through an RPC failure', async () => {
    callSessionRpc.mockRejectedValue(new Error('RPC target unavailable'));
    const deps = createCliSessionModelActionDeps({
      token: 'fixture-token', credentials: { token: 'fixture-token', encryption: null },
    }, { projectHomeId: 'fixture-home', resolveServerRequestHeaders: () => null });

    const result = await deps.sessionModelSet!({ sessionId, modelId: requestedSelection.modelId,
      providerConnectionId: requestedSelection.providerConnectionId });

    expect(result).toMatchObject({ ok: false, errorCode: 'owner_unavailable',
      details: { status: 'owner_unavailable', activeSelection: null, requestedSelection,
        failureCause: { phase: 'turn_start', failureReason: 'unknown' } } });
  });

  it.each(['restart_required', 'unsupported', 'apply_failed'] as const)(
    'preserves %s and the actual model, offering new-Session recovery only for restart',
    async (status) => {
      const transition = SessionModelTransitionResultV1Schema.parse({
        ok: false, status, activeSelection, requestedSelection,
        ...(status === 'unsupported' ? { reason: 'exact_model_mutation_requires_live_transition' } : {}),
        ...(status === 'apply_failed' ? { failureCause: {
          phase: 'turn_start', failureReason: 'unclassified_provider_error', providerErrorCode: -32602,
        } } : {}),
      });
      callSessionRpc.mockResolvedValue(transition);
      const deps = createCliSessionModelActionDeps({
        token: 'fixture-token',
        credentials: { token: 'fixture-token', encryption: null },
      }, { projectHomeId: 'fixture-home', resolveServerRequestHeaders: () => null });

      const result = await deps.sessionModelSet!({ sessionId, modelId: requestedSelection.modelId,
        providerConnectionId: requestedSelection.providerConnectionId });

      expect(result).toMatchObject({ ok: false, errorCode: status,
        details: { status, activeSelection, requestedSelection,
          ...(status === 'apply_failed' ? { failureCause: transition.failureCause } : {}),
        } });
      const presented = normalizeActionExecuteResult({ ok: true, result });
      expect(presented.ok).toBe(false);
      if (!presented.ok) {
        if (status === 'restart_required') expect(presented.errorMessage).toContain('happier session create');
        else expect(presented.errorMessage).toBe(status);
      }
    },
  );
});
