import type {
  AttachSurface,
  CheckpointSurface,
  AgentSessionRuntimeContext,
  AgentSessionModesSource,
  AgentAccountUsageSubscription,
} from '@happier-dev/plugin-sdk/agents/runtime';

// Account observations carry optional provider payment or dated list facts;
// an author does not need to supply prices when the provider reports none.
export const observedSubscription = {
  status: 'subscribed',
  renewal: 'on',
  observedAtMs: 1_000,
  staleAfterMs: 60_000,
  monetaryFacts: [{
    kind: 'paid', amount: 20, currency: 'USD',
    period: { startAtMs: 0, endAtMs: 30_000 },
    source: { kind: 'provider', id: 'account-payment', version: '1' },
    effectiveAtMs: 0, asOfMs: 1_000,
  }, {
    kind: 'list', amount: 25, currency: 'USD',
    period: { startAtMs: 0, endAtMs: 30_000 },
    source: { kind: 'published', id: 'dated-provider-list', version: '2026-10' },
    effectiveAtMs: 0, asOfMs: 1_000,
  }],
} as const satisfies AgentAccountUsageSubscription;

// Authors supply native facts through the session-owned service, not owner metadata writes.
export function bindNativeModes(context: AgentSessionRuntimeContext, source: AgentSessionModesSource) {
  return context.session.services.modes.bind(source);
}

// Recovery is an optional admitted host operation, never a launch preference flag.
export async function adoptRetainedTerminal(context: AgentSessionRuntimeContext) {
  const host = context.session.services.terminalHost;
  if (!host?.adoptExistingHost) throw new Error('Retained terminal adoption is unavailable');
  return await host.adoptExistingHost();
}

type AttachResult = Awaited<ReturnType<AttachSurface['attach']>>;
type CheckpointRestore = NonNullable<CheckpointSurface['restore']>;
type CheckpointRestoreResult = Awaited<ReturnType<CheckpointRestore>>;

const runtimeDescriptor = {
  v: 1 as const,
  agentId: 'example.inference',
  agent: Object.freeze({ providerSessionId: 'provider-session-1' }),
};

const attachIdentityResult: AttachResult = {
  ok: true,
  value: { exitCode: 0 },
  receipt: {
    sessionStateUpdates: [
      { fieldId: 'identity.runtimeDescriptor', value: runtimeDescriptor },
      { fieldId: 'identity.providerSessionId', value: 'provider-session-1' },
    ],
  },
};

const checkpointIdentityResult: CheckpointRestoreResult = {
  ok: true,
  outcome: 'completed',
  restoredScopes: ['conversation'],
  receipt: {
    sessionStateUpdates: [
      { fieldId: 'identity.runtimeDescriptor', value: runtimeDescriptor },
      { fieldId: 'identity.providerSessionId', value: 'provider-session-1' },
    ],
  },
};

const attachPrivateStateResult: AttachResult = {
  ok: true,
  value: { exitCode: 0 },
  receipt: {
    sessionStateUpdates: [{
      // @ts-expect-error Agent Attach authors cannot write owner-private Session state.
      fieldId: 'runtime.externalSessionOperation',
      value: 'private-operation',
    }],
  },
};

const checkpointPrivateStateResult: CheckpointRestoreResult = {
  ok: false,
  code: 'restore_failed',
  receipt: {
    sessionStateUpdates: [{
      // @ts-expect-error Agent Checkpoint authors cannot write owner-private Session state.
      fieldId: 'runtime.externalSessionOperation',
      value: 'private-operation',
    }],
  },
};

void attachIdentityResult;
void checkpointIdentityResult;
void attachPrivateStateResult;
void checkpointPrivateStateResult;
