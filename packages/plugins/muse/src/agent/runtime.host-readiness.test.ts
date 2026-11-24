// OS activity injection is a schema-derived ordering of captured Muse1.4.14 status frames.
// Socket/HTTP/native-child boundaries are fixtures; host custody and Muse logic stay real.
import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeAgentSessionOperations, type NativeAgentNewTurnAdmissionWitness } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createSessionProviderInputOutcomeNormalizer, type SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

type Operations = ReturnType<typeof createNativeAgentSessionOperations>;
type DeliveryOutcome = Parameters<NonNullable<Parameters<NonNullable<Operations['setOnPromptDeliveryOutcome']>>[0]>>[0];

it.each(['release', 'cancel-before-ready'] as const)('keeps native input in host custody until ready (%s)', async disposition => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-readiness-'));
  const nativeNotificationPath = join(scratch, 'native-notification.json');
  let disposeFixture: (() => Promise<void>) | undefined;
  const witnesses: NativeAgentNewTurnAdmissionWitness[] = [];
  const outcomes: DeliveryOutcome[] = [];
  let operations: Operations | undefined;
  let pendingDelivery: Promise<void> | undefined;
  try {
    const fixture = await createAdmittedMuseSessionFixture({ native: { nativeNotificationPath, readinessGuard: true } });
    disposeFixture = () => fixture.dispose();
    const opened = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    const definition = PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse');
    const capabilities = readAgentSessionCapabilities(definition);
    if (!capabilities) throw new Error('Admitted Muse Session declaration is unavailable');
    const nativeId = opened.runtimeDescriptorV1?.agent.providerSessionId;
    if (typeof nativeId !== 'string') throw new Error('Expected admitted native identity');
    operations = createNativeAgentSessionOperations(
      opened, 'host-admitted-muse', undefined, nativeId, undefined, undefined, undefined,
      { context: fixture.context, cwd: process.cwd(), connectedAccounts: [], capabilities,
        // This test invokes only host-held-input cancellation; no native cancel/config/compact facet.
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } },
      fixture.publications, [], undefined, undefined,
      async witness => {
        // Fake external daemon admission response; witness is produced by the real host.
        witnesses.push(witness);
        return { status: 'admitted' };
      },
    );
    operations.setOnPromptDeliveryOutcome?.(outcome => outcomes.push(outcome));
    const captured = JSON.parse(await readFile(new URL('./testkit/fixtures/login-smoke.json', import.meta.url), 'utf8'));
    const statusFrame = captured.rows.find((row: { message?: { method?: string } }) => row.message?.method === 'session/statusChanged').message;
    async function releaseNativeInput() {
      // The OS boundary emits this captured notification and records its readiness change.
      const completeNotificationPath = `${nativeNotificationPath}.complete`;
      await writeFile(completeNotificationPath, JSON.stringify({ ...statusFrame,
        params: { ...statusFrame.params, sessionId: nativeId, status: 'idle' } }));
      await rename(completeNotificationPath, nativeNotificationPath);
      await fixture.waitForAudit(audit => audit.readinessState === 'ready');
    }
    await fixture.waitForAudit(audit => audit.readinessState === 'busy');
    pendingDelivery = fixture.run(() => operations!.sendTurnPrompt('Reply with exactly PEBBLE. Do not use tools.', {
      localId: 'held-input', turnId: 'held-turn', userMessageSeq: 7,
    }));
    // Attach rejection handling immediately; host cancellation is expected in the second case.
    const settled = pendingDelivery.then(() => ({ status: 'delivered' as const }), () => ({ status: 'retired' as const }));
    // Same single event-loop boundary used by the canonical host readiness test.
    // Allows the existing AsyncLock dispatch to enter its passive readiness wait; no elapsed-time assertion.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(witnesses).toEqual([]);
    expect(outcomes).toEqual([]);
    if (disposition === 'cancel-before-ready') {
      await operations.cancelTurn();
      await expect(settled).resolves.toEqual({ status: 'retired' });
      expect(witnesses).toEqual([]);
      // Readiness may settle later, but the host's cancelled correlation cannot dispatch.
      await releaseNativeInput();
    } else {
      await releaseNativeInput();
      await expect(settled).resolves.toEqual({ status: 'delivered' });
      expect(witnesses).toMatchObject([{ inputId: 'held-input', turnId: 'held-turn', userMessageSeq: 7 }]);
      expect(witnesses).toHaveLength(1);
      expect(outcomes).toMatchObject([{ type: 'input-accepted', localId: 'held-input',
        delivery: { kind: 'newTurn', turnId: 'held-turn' } }]);
    }
    await operations.resetOrDisposeRuntime('session_closed'); operations = undefined;
    const audit = await fixture.readAudit();
    expect(audit.earlyTurnCount).toBe(0);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(disposition === 'release' ? 1 : 0);
    expect(audit.methods.filter(method => method === 'turn/interrupt' || method === 'turn/unqueue')).toEqual([]);
  } finally {
    await operations?.resetOrDisposeRuntime('session_closed');
    await pendingDelivery?.catch(() => undefined);
    await disposeFixture?.();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('settles a later send when Muse closes before the daemon replies to admission', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-admission-'));
  const nativeNotificationPath = join(scratch, 'native-notification.json');
  let disposeFixture: (() => Promise<void>) | undefined;
  let operations: Operations | undefined;
  let pendingDelivery: Promise<unknown> | undefined;
  try {
    const fixture = await createAdmittedMuseSessionFixture({ native: { nativeNotificationPath } });
    disposeFixture = fixture.dispose;
    const sessionId = 'host-admitted-muse';
    const opened = await fixture.open({ kind: 'create', sessionId, cwd: process.cwd() });
    const capabilities = readAgentSessionCapabilities(PLUGIN_MANIFEST.contributes.agents?.find(agent => agent.id === 'muse'));
    const nativeId = opened.runtimeDescriptorV1?.agent.providerSessionId;
    if (!capabilities || !nativeId) throw new Error('Expected admitted Muse Session');
    const admissionEntered = Promise.withResolvers<void>();
    const runtimeEnded = Promise.withResolvers<void>();
    const attemptedSettlement = Promise.withResolvers<void>();
    const settlements: SessionProviderInputOutcome[] = [];
    operations = createNativeAgentSessionOperations(
      opened, sessionId, undefined, nativeId, undefined, undefined, undefined,
      { context: fixture.context, cwd: process.cwd(), connectedAccounts: [], capabilities,
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } },
      fixture.publications, [], undefined, undefined,
      async (witness, { signal }) => {
        if (witness.inputId === 'first-input') return { status: 'admitted' };
        // The daemon has taken the request but its response remains open.
        admissionEntered.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    );
    operations.subscribeRuntimeEvents(event => {
      if (event.kind === 'runtime-ended') runtimeEnded.resolve();
    });
    operations.setOnPromptDeliveryOutcome?.(createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({ sessionId, hasPendingProviderInput: () => true,
        async observeProviderInputSettlement(outcome) {
          settlements.push(outcome);
          if (outcome.localId === 'first-input') {
            attemptedSettlement.resolve();
            throw new Error('Pending settlement response lost');
          }
        },
      }),
    }));
    const host = operations;
    await fixture.run(() => host.sendTurnPrompt('Reply with exactly PEBBLE. Do not use tools.', {
      localId: 'first-input', turnId: 'first-turn', userMessageSeq: 7,
    }));
    await attemptedSettlement.promise;
    await host.waitForTurnCompletion();
    expect(settlements).toMatchObject([{ kind: 'accepted', localId: 'first-input' }]);

    let outcome: unknown = 'pending';
    pendingDelivery = fixture.run(() => host.sendTurnPrompt('Reply with exactly QUARTZ. Do not use tools.', {
      localId: 'second-input', turnId: 'second-turn', userMessageSeq: 8,
    })).then(() => { outcome = 'sent'; }, error => { outcome = error; });
    await admissionEntered.promise;
    expect(outcome).toBe('pending');

    const completeNotificationPath = `${nativeNotificationPath}.complete`;
    await writeFile(completeNotificationPath, JSON.stringify({ jsonrpc: '2.0', method: 'session/closed', params: { sessionId: nativeId } }));
    await rename(completeNotificationPath, nativeNotificationPath);
    await runtimeEnded.promise;
    await vi.waitFor(() => expect(outcome).toMatchObject({ code: 'native_agent_runtime_ended' }));
    expect(settlements).toMatchObject([
      { kind: 'accepted', localId: 'first-input' },
      { kind: 'rejected_before_effect', localId: 'second-input', reason: 'host_retired_before_dispatch',
        retryable: true, retireLocalCustodyAfterDurableBlock: true },
    ]);
    expect((await fixture.readAudit()).methods.filter(method => method === 'turn/start')).toHaveLength(1);
  } finally {
    await operations?.resetOrDisposeRuntime('session_closed');
    await pendingDelivery;
    await disposeFixture?.();
    await rm(scratch, { recursive: true, force: true });
  }
});
