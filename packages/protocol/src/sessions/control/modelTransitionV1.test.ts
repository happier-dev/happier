import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from '../../rpc/index.js';
import {
  SessionModelTransitionRequestV1Schema,
  SessionModelTransitionResultV1Schema,
} from './modelTransitionV1.js';

describe('session model transition host-private control contract', () => {
  it('uses one structured private session route', () => {
    expect(SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION).toBe('session.model.transition');
    expect(SessionModelTransitionRequestV1Schema.parse({
      v: 1,
      selection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_work',
        modelId: 'claude-sonnet',
      },
    })).toEqual({
      v: 1,
      selection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_work',
        modelId: 'claude-sonnet',
      },
    });
  });

  it('rejects model-only requests that discard Provider identity', () => {
    expect(SessionModelTransitionRequestV1Schema.safeParse({
      v: 1,
      modelId: 'claude-sonnet',
    }).success).toBe(false);
  });

  it('keeps active and requested structured refs in typed failure results', () => {
    expect(SessionModelTransitionResultV1Schema.parse({
      ok: false,
      status: 'restart_required',
      activeSelection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_work',
        modelId: 'old',
      },
      requestedSelection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_other',
        modelId: 'next',
      },
    })).toMatchObject({
      ok: false,
      status: 'restart_required',
      activeSelection: { providerConnectionId: 'pc_work' },
      requestedSelection: { providerConnectionId: 'pc_other' },
    });
  });

  it('does not require callers to invent active truth when the exact run owner is unavailable', () => {
    expect(SessionModelTransitionResultV1Schema.parse({
      ok: false,
      status: 'owner_unavailable',
      activeSelection: null,
      requestedSelection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_other',
        modelId: 'next',
      },
    })).toMatchObject({
      ok: false,
      status: 'owner_unavailable',
      activeSelection: null,
    });
  });

  it('allows reconciliation to report unknown active truth after an uncertain runtime effect', () => {
    expect(SessionModelTransitionResultV1Schema.parse({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
      requestedSelection: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_work',
        modelId: 'next',
      },
      reason: 'runtime_model_transition_outcome_unproven',
    })).toMatchObject({
      ok: false,
      status: 'reconciliation_required',
      activeSelection: null,
    });
  });
});
