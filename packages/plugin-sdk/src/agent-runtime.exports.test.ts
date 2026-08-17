import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentProviderBindingLaunchMaterializationV1 } from '@happier-dev/protocol';

import * as agentRuntime from './agent-runtime.js';
import * as publicAgentRuntime from './agents/runtime/index.js';
import type {
  AgentRuntime,
  AgentSessionOpenRequest,
  AgentSessionProviderBinding,
  AgentSessionHostServices,
  AttachSurface,
  CheckpointSurface,
} from './agent-runtime.js';

type AgentRuntimeSurfaces = NonNullable<AgentRuntime['surfaces']>;
type AttachResult = Awaited<ReturnType<AttachSurface['attach']>>;
type AttachReceipt = NonNullable<Extract<AttachResult, { ok: true }>['receipt']>;
type CheckpointRestore = NonNullable<CheckpointSurface['restore']>;
type CheckpointReceipt = NonNullable<Awaited<ReturnType<CheckpointRestore>>['receipt']>;

describe('public agent-runtime entrypoint', () => {
  it('exports the strict provider-neutral wire validators', () => {
    expect(agentRuntime.AgentSessionRuntimeEventSchema.safeParse({
      kind: 'turn-complete',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      turnId: 'turn-1',
    }).success).toBe(true);
  });

  it('does not expose retired versioned validators or compatibility helpers', () => {
    const publicRuntime = agentRuntime as Readonly<Record<string, unknown>>;
    for (const removed of [
      'AGENT_SESSION_RUNTIME_LIMITS_V1',
      'AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1',
      'RuntimeCore',
      'AgentRuntimeV1',
      'AcpSessionRuntimeV1',
      'createSessionRuntime',
      'createExecutionRunBackend',
      'createAgentSessionRuntimeEventStream',
      'createAgentRuntimeFactoryFromV1',
      'measureAgentSessionRuntimeEventJsonBytes',
      'readAgentRuntimeV1CompatibilityFactory',
      'RuntimeEventV1Schema',
      'AgentRuntimeJsonValueV1Schema',
      'AgentSessionCompactRequestV1Schema',
      'AgentSessionConversationRollbackReconciliationResultV1Schema',
      'AgentSessionConversationRollbackRequestV1Schema',
      'AgentSessionConversationRollbackResultV1Schema',
      'AgentSessionRuntimeEventV1Schema',
      'AgentSessionSendRequestV1Schema',
    ]) {
      expect(publicRuntime[removed], removed).toBeUndefined();
    }
  });

  it('keeps the real public ./agents/runtime entrypoint free of retired event validators', () => {
    const runtime = publicAgentRuntime as Readonly<Record<string, unknown>>;
    for (const removed of [
      'RuntimeEventV1Schema',
      'AgentSessionRuntimeEventV1Schema',
    ]) {
      expect(runtime[removed], removed).toBeUndefined();
    }
  });

  it('keeps External Sessions out of the primary AgentRuntime facets', () => {
    expectTypeOf<AgentRuntimeSurfaces>().toHaveProperty('terminal');
    expectTypeOf<AgentRuntimeSurfaces>().not.toHaveProperty('externalSessions');
  });

  it('exports SDK-owned attach and checkpoint surfaces with identity-only receipts', () => {
    expectTypeOf<NonNullable<AttachReceipt['sessionStateUpdates']>[number]['fieldId']>()
      .toEqualTypeOf<'identity.runtimeDescriptor' | 'identity.providerSessionId'>();
    expectTypeOf<NonNullable<CheckpointReceipt['sessionStateUpdates']>[number]['fieldId']>()
      .toEqualTypeOf<'identity.runtimeDescriptor' | 'identity.providerSessionId'>();
  });

  it('keeps feature decisions and optional terminal control session-bound without exposing private system records', () => {
    expectTypeOf<AgentSessionHostServices>().toHaveProperty('features');
    expectTypeOf<AgentSessionHostServices>().toHaveProperty('terminalHost');
    expectTypeOf<AgentSessionHostServices>().not.toHaveProperty('systemRecords');
    expectTypeOf<AgentSessionHostServices>().toHaveProperty('workflowActivity');
  });

  it('exposes one bounded Provider binding input on every session-open variant', () => {
    expectTypeOf<AgentSessionOpenRequest>().toHaveProperty('providerBinding');
    expectTypeOf<NonNullable<AgentSessionOpenRequest['providerBinding']>>()
      .toEqualTypeOf<AgentSessionProviderBinding>();
    expectTypeOf<AgentSessionProviderBinding>().toHaveProperty('connectionId');
    expectTypeOf<AgentSessionProviderBinding>().toHaveProperty('model');
    expectTypeOf<AgentSessionProviderBinding>().toHaveProperty('materialization');
    expectTypeOf<AgentProviderBindingLaunchMaterializationV1>()
      .toMatchTypeOf<AgentSessionProviderBinding['materialization']>();
    expectTypeOf<AgentSessionProviderBinding>().not.toHaveProperty('modelId');
    expectTypeOf<AgentSessionProviderBinding>().not.toHaveProperty('agentTargetKey');
  });
});
