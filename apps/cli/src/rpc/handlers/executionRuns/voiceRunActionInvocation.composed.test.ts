import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { withAdmittedSessionRun } from '@/agent/runtime/bridges/executionRun/testkit/admittedSessionRun.composed';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { createExecutionRunRpcActionDeps } from './dispatchExecutionRunRpcAction';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

it('retains only the exact signed Voice root when fresh Ensure-or-Start creates a Run', async () => {
  await withAdmittedSessionRun({ directOwner: true, run: async fixture => {
    if (!fixture.bridge) throw new Error('Missing real Run host');
    const manager = fixture.bridge;
    // The authored external Agent SDK is the process boundary. All Run,
    // configuration, invocation admission and lifecycle owners remain real.
    fixture.nativeOpen.mockImplementation(async request => {
      let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      let sequence = 0;
      const base = () => ({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now() });
      return {
        watch(listener) { emit = listener; listener({ ...base(), kind: 'provider-session-id', providerSessionId: 'voice-invocation-fixture' });
          return { dispose() { emit = undefined; } }; },
        async send(input) {
          const turnId = input.delivery.turnId;
          emit?.({ ...base(), kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
          emit?.({ ...base(), kind: 'turn-start', turnId, startedBy: 'host' });
          emit?.({ ...base(), kind: 'message-delta', turnId, channel: 'assistant', text: 'READY' });
          emit?.({ ...base(), kind: 'turn-complete', turnId });
          return { status: 'admitted' };
        },
        async dispose() {},
      };
    });
    const deps = createExecutionRunRpcActionDeps({ manager,
      context: { sessionId: fixture.session.sessionId, cwd: fixture.directory,
        getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } } }) }) },
      policy: resolveExecutionRunPolicy({ defaults: { boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null } }),
      isExecutionRunsEnabled: () => true,
    });
    const invocation = { caller: { kind: 'host' }, surface: 'voice', authority: 'present_user' } as const;
    const start = ExecutionRunStartRequestSchema.parse({ intent: 'voice_agent',
      backendTarget: { kind: 'agent', identity: fixture.agentIdentity }, instructions: '',
      modelId: 'fixture-model', chatModelId: 'fixture-model', commitModelId: 'fixture-model',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      connectedServices: { v: 2, bindingsByServiceId: {} }, actionInvocation: invocation,
    });
    for (const proof of ['matching-root', 'wrong-root', 'unsigned'] as const) {
      // This is the already-verified private Account RPC boundary, not a
      // public Run field. The production socket opener verifies its signature.
      const context: NonNullable<Parameters<NonNullable<typeof deps.executionRunEnsureOrStart>>[2]> = { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' },
        ...(proof === 'unsigned' ? {} : { externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1, token: 'verified-private-rpc-fixture', binding: { serverIdentityId: 'home', accountId: 'alice', custodianAccountId: 'alice',
            authentication: { kind: 'account', tokenEpoch: 0 }, installationId: 'installation', machineId: 'machine',
            actionId: proof === 'matching-root' ? 'execution.run.ensure_or_start' : 'execution.run.start',
            requestId: `voice-${proof}`, requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' } },
        }) }),
      };
      const result = await deps.executionRunEnsureOrStart!(fixture.session.sessionId, { start }, context);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, created: true, runId: expect.any(String) });
      if (!('runId' in result) || typeof result.runId !== 'string') throw new Error('Missing created Run');
      if (proof === 'matching-root') {
        expect(result).toHaveProperty('actionInvocation', invocation);
        expect(manager.get(result.runId)).toHaveProperty('actionInvocation', invocation);
      } else {
        expect(result).not.toHaveProperty('actionInvocation');
        expect(manager.get(result.runId)?.actionInvocation).toBeUndefined();
      }
      await manager.stop(result.runId);
    }
  } });
});
