import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent, AgentSessionStartupInstructionsMarkerV1, AgentSessionStartupInstructionsV1 } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from './modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from './permissions/queuedPrompt';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { createSessionProviderInputConsumer } from './session/input/sessionProviderInputConsumer';
import { createSessionProviderInputConsumerSessionAdapter } from './waitForNextPermissionModeMessage';

type PlanTurn = Readonly<{
  text: string;
  plan: string;
  accepted?: boolean;
  compact?: 'started' | 'completed';
  compactionBeforeAcceptance?: boolean;
  deliveryState?: ReturnType<NonNullable<Parameters<typeof runPermissionModePromptLoop>[0]['readSessionPromptPlanDeliveryState']>>;
}>;

async function dispatchPlans(turns: readonly PlanTurn[], nativePlans?: string[], initialNativePlan?: string,
  nativeMarkers?: AgentSessionStartupInstructionsMarkerV1[], initialResumeId?: string) {
  const session = createMutableApiSessionClientFixture<Metadata>();
  session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
  const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
  );
  const inputConsumer = createSessionProviderInputConsumer({
    messageQueue: queue, session: createSessionProviderInputConsumerSessionAdapter(session),
  });
  const acceptedEffects = new Map<string, (() => void) | null>();
  const runtimeListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  const prompts: string[] = [];
  let index = 0;
  let finished = false;
  let nativeInstructions: AgentSessionStartupInstructionsV1 | null = initialNativePlan
    ? { v: 1, id: 'happier.coding_session_plan', revision: 1, instructions: initialNativePlan } : null;
  queue.push({ text: turns[0].text, localId: 'input-0' }, { permissionMode: 'default', appendSystemPrompt: 'BASE_OVERRIDE' });
  // Only the Agent's native I/O and Session transport are substituted. Queue,
  // prompt composition/dispatch and provider-acceptance custody remain real.
  await runPermissionModePromptLoop({
    providerName: 'Test Agent', agentMessageType: 'qwen', explicitPermissionMode: undefined,
    session, messageQueue: queue, inputConsumer, permissionHandler: { setPermissionMode: () => undefined, reset: () => undefined },
    runtime: {
      beginTurnLifecycle: () => undefined,
      sendTurnPrompt: async (prompt, meta) => {
        prompts.push(prompt);
        const emitCompaction = () => {
          const phase = turns[index].compact;
          if (phase) for (const listener of runtimeListeners) listener({
            kind: 'context-compaction', sequence: index + 1, sessionId: session.sessionId,
            emittedAtMs: index + 1, compactionId: `compact-${index}`, trigger: 'automatic', phase,
          });
        };
        if (turns[index].compactionBeforeAcceptance) emitCompaction();
        if (turns[index].accepted !== false && meta?.localId) acceptedEffects.get(meta.localId)?.();
        if (!turns[index].compactionBeforeAcceptance) emitCompaction();
      },
      isProviderNativeCommand: (text) => text.startsWith('/native'),
      steerInFlightTurn: async () => undefined,
      waitForTurnCompletion: async () => undefined,
      subscribeRuntimeEvents: (listener) => { runtimeListeners.add(listener); return () => { runtimeListeners.delete(listener); }; },
      cancelTurn: async () => undefined,
      readSessionIdentity: () => ({ sessionId: 'native-session' }),
      readSessionStartupInstructions: () => nativeInstructions,
      updateSessionRuntimeConfig: async () => undefined,
      resetOrDisposeRuntime: async (reason, intent) => {
        // Native replacement invokes the host admission lifecycle before opening
        // the successor. Keep that owner real alongside the native I/O boundary.
        await inputConsumer.enforceProviderInputAdmission({
          kind: 'action_required', reason: 'generation_pending',
          serviceId: 'host-runtime', groupId: 'primary-runtime', epochId: 'replacement',
        });
        nativeInstructions = intent?.startupInstructions ?? null;
        if (intent?.startupInstructions) {
          expect(reason).toBe('session_closed');
          expect(intent).toMatchObject({ kind: 'resume', providerSessionId: 'native-session', importHistory: false });
          nativePlans?.push(intent.startupInstructions.instructions);
          const { instructions: _instructions, ...marker } = intent.startupInstructions;
          nativeMarkers?.push(marker);
        }
        await inputConsumer.clearProviderInputAdmission({
          serviceId: 'host-runtime', groupId: 'primary-runtime', epochId: 'replacement',
        });
      },
    },
    createOverrideSynchronizer: () => ({ syncFromMetadata: () => undefined, flushPendingAfterStart: async () => undefined }),
    messageBuffer: new MessageBuffer(), shouldExit: () => finished, getAbortSignal: () => new AbortController().signal,
    keepAlive: () => undefined, setThinking: () => undefined,
    sendReady: () => {
      index += 1;
      if (index === turns.length) { finished = true; return; }
      queue.push({ text: turns[index].text, localId: `input-${index}` }, { permissionMode: 'default', appendSystemPrompt: 'BASE_OVERRIDE' });
    },
    currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode: () => undefined, setCurrentPermissionModeUpdatedAt: () => undefined,
    initialResumeId,
    resolveFreshSessionSystemPrompt: async ({ baseOverride }) => {
      expect(baseOverride).toBe('BASE_OVERRIDE');
      return turns[index].plan;
    },
    readSessionPromptPlanDeliveryState: () => turns[index].deliveryState ?? { startupInstructionsSupported: false },
    registerProviderAcceptedEffect: (localId, effect) => { acceptedEffects.set(localId, effect); },
    formatPromptErrorMessage: String,
  });
  expect(runtimeListeners.size).toBe(0);
  return prompts;
}

describe('session prompt-plan re-delivery', () => {
  const supersedingPlan = (plan: string) => `These instructions supersede the Happier startup instructions and any earlier Happier session plan.\n\n${plan}`;
  it('uses the initial native full plan without reopening, then keeps unsupported resume revisions on prefix fallback', async () => {
    const nativePlans: string[] = [];
    const deliveryState = { startupInstructionsSupported: true };
    expect(await dispatchPlans([
      { text: 'first', plan: 'ROLE_ONE', deliveryState },
      { text: 'changed', plan: 'ROLE_TWO', deliveryState },
      { text: 'same', plan: 'ROLE_TWO', deliveryState },
    ], nativePlans, 'ROLE_ONE')).toEqual(['first', `${supersedingPlan('ROLE_TWO')}\n\nchanged`, 'same']);
    expect(nativePlans).toEqual([]);
  });

  it('keeps an accepted native plan across compaction without restarting the conversation', async () => {
    const nativePlans: string[] = [];
    const deliveryState = { startupInstructionsSupported: true, revisionChanges: 'resume' as const };
    expect(await dispatchPlans([
      { text: 'first', plan: 'ROLE', deliveryState, compact: 'completed' },
      { text: 'after compaction', plan: 'ROLE', deliveryState },
    ], nativePlans)).toEqual(['first', 'after compaction']);
    expect(nativePlans).toEqual(['ROLE']);
  });
  it('prepares a native plan once, reopens for changed instructions, and keeps unchanged turns prefix-free', async () => {
    const nativePlans: string[] = [];
    const deliveryState = { startupInstructionsSupported: true, revisionChanges: 'resume' as const };
    expect(await dispatchPlans([
      { text: 'first', plan: 'ROLE_ONE', deliveryState },
      { text: 'same', plan: 'ROLE_ONE', deliveryState },
      { text: 'changed', plan: 'ROLE_TWO', deliveryState },
      { text: 'same again', plan: 'ROLE_TWO', deliveryState },
    ], nativePlans)).toEqual(['first', 'same', 'changed', 'same again']);
    expect(nativePlans).toEqual(['ROLE_ONE', 'ROLE_TWO']);
  });

  it('keeps revision changes and compaction on fallback when native resume does not apply changes', async () => {
    const nativePlans: string[] = [];
    const deliveryState = { startupInstructionsSupported: true };
    expect(await dispatchPlans([
      { text: 'first', plan: 'ROLE_ONE', deliveryState },
      { text: 'changed', plan: 'ROLE_TWO', deliveryState, compact: 'completed' },
      { text: 'after compaction', plan: 'ROLE_TWO', deliveryState },
    ], nativePlans, 'ROLE_ONE')).toEqual(['first', `${supersedingPlan('ROLE_TWO')}\n\nchanged`, `${supersedingPlan('ROLE_TWO')}\n\nafter compaction`]);
    expect(nativePlans).toEqual([]);
  });

  it('retains superseding fallback after compaction, a native command and an unaccepted retry on resume', async () => {
    const nativePlans: string[] = [];
    const deliveryState = { startupInstructionsSupported: true };
    expect(await dispatchPlans([
      { text: 'resumed', plan: 'ROLE_TWO', deliveryState, compact: 'completed', compactionBeforeAcceptance: true },
      { text: '/native inspect', plan: 'ROLE_TWO', deliveryState },
      { text: 'unaccepted', plan: 'ROLE_TWO', deliveryState, accepted: false },
      { text: 'retry', plan: 'ROLE_TWO', deliveryState },
      { text: 'unchanged', plan: 'ROLE_TWO', deliveryState },
    ], nativePlans, undefined, undefined, 'native-session')).toEqual([
      `${supersedingPlan('ROLE_TWO')}\n\nresumed`, '/native inspect',
      `${supersedingPlan('ROLE_TWO')}\n\nunaccepted`, `${supersedingPlan('ROLE_TWO')}\n\nretry`, 'unchanged',
    ]);
    expect(nativePlans).toEqual([]);
  });

  it('supersedes retained startup instructions after resuming a startup-only agent without a process-local native marker', async () => {
    const deliveryState = { startupInstructionsSupported: true };
    const nativePlans: string[] = [];
    expect(await dispatchPlans([
      { text: 'resumed', plan: 'ROLE_ONE', deliveryState },
      { text: 'changed', plan: 'ROLE_TWO', deliveryState },
      { text: 'unchanged', plan: 'ROLE_TWO', deliveryState },
    ], nativePlans, undefined, undefined, 'native-session')).toEqual([
      `${supersedingPlan('ROLE_ONE')}\n\nresumed`, `${supersedingPlan('ROLE_TWO')}\n\nchanged`, 'unchanged',
    ]);
    expect(nativePlans).toEqual([]);
  });

  it('re-delivers a startup-only agent revision until provider acceptance, even when its text returns to the startup plan', async () => {
    const deliveryState = { startupInstructionsSupported: true };
    expect(await dispatchPlans([
      { text: 'first', plan: 'ROLE_ONE', deliveryState },
      { text: 'unaccepted change', plan: 'ROLE_TWO', deliveryState, accepted: false },
      { text: 'retry change', plan: 'ROLE_TWO', deliveryState },
      { text: 'return to original', plan: 'ROLE_ONE', deliveryState },
      { text: 'unchanged', plan: 'ROLE_ONE', deliveryState },
    ], [], 'ROLE_ONE')).toEqual(['first',
      `${supersedingPlan('ROLE_TWO')}\n\nunaccepted change`,
      `${supersedingPlan('ROLE_TWO')}\n\nretry change`,
      `${supersedingPlan('ROLE_ONE')}\n\nreturn to original`, 'unchanged']);
  });

  it('uses the producer marker on native resume, including a revision change with identical text', async () => {
    const marker = { v: 1 as const, id: 'happier.coding_session_plan', revision: 9 };
    const deliveryState = { marker, startupInstructionsSupported: true, revisionChanges: 'resume' as const };
    const nativeMarkers: AgentSessionStartupInstructionsMarkerV1[] = [];
    expect(await dispatchPlans([
      { text: 'first', plan: 'ROLE', deliveryState },
      { text: 'new revision', plan: 'ROLE', deliveryState: { ...deliveryState, marker: { ...marker, revision: 12 } } },
    ], [], undefined, nativeMarkers)).toEqual(['first', 'new revision']);
    expect(nativeMarkers).toEqual([marker, { ...marker, revision: 12 }]);
  });

  it('delivers changed plans, including Launch Profile text, and omits unchanged accepted plans', async () => {
    const first = 'ROLE_ONE\nLAUNCH_PROFILE_APPEND';
    const next = 'ROLE_TWO\nLAUNCH_PROFILE_APPEND';
    expect(await dispatchPlans([
      { text: 'first', plan: first }, { text: 'unchanged', plan: first },
      { text: 'changed', plan: next }, { text: 'unchanged again', plan: next },
    ])).toEqual([`${first}\n\nfirst`, 'unchanged', `${next}\n\nchanged`, 'unchanged again']);
  });

  it('re-delivers the full plan only after completed canonical automatic compaction', async () => {
    const plan = 'ROLE\nLAUNCH_PROFILE_APPEND';
    expect(await dispatchPlans([
      { text: 'first', plan, compact: 'started' }, { text: 'still retained', plan, compact: 'completed' },
      { text: 'after compaction', plan }, { text: 'unchanged', plan },
    ])).toEqual([`${plan}\n\nfirst`, 'still retained', `${plan}\n\nafter compaction`, 'unchanged']);
  });

  it('does not settle delivery on preparation or provider-send completion', async () => {
    expect(await dispatchPlans([
      { text: 'unaccepted', plan: 'ROLE', accepted: false },
      { text: 'retry', plan: 'ROLE' }, { text: 'accepted already', plan: 'ROLE' },
    ])).toEqual(['ROLE\n\nunaccepted', 'ROLE\n\nretry', 'accepted already']);
  });

  it('does not let late acceptance erase a completed-compaction re-delivery', async () => {
    expect(await dispatchPlans([
      { text: 'compacting', plan: 'ROLE', compact: 'completed', compactionBeforeAcceptance: true },
      { text: 'after compaction', plan: 'ROLE' }, { text: 'retained', plan: 'ROLE' },
    ])).toEqual(['ROLE\n\ncompacting', 'ROLE\n\nafter compaction', 'retained']);
  });

  it('uses the canonical plan marker revision even when the rendered text is unchanged', async () => {
    const marker: AgentSessionStartupInstructionsMarkerV1 = { v: 1, id: 'coding.session-plan', revision: 1 };
    expect(await dispatchPlans([
      { text: 'first', plan: 'ROLE', deliveryState: { marker, startupInstructionsSupported: false } },
      { text: 'new revision', plan: 'ROLE', deliveryState: { marker: { ...marker, revision: 2 }, startupInstructionsSupported: false } },
    ])).toEqual(['ROLE\n\nfirst', 'ROLE\n\nnew revision']);
  });

  it('keeps native commands verbatim and carries pending changed plans to the next normal turn', async () => {
    expect(await dispatchPlans([
      { text: '/native first', plan: 'ROLE_ONE' }, { text: 'normal', plan: 'ROLE_ONE' },
      { text: '/native after change', plan: 'ROLE_TWO' }, { text: 'changed normal', plan: 'ROLE_TWO' },
    ])).toEqual(['/native first', 'ROLE_ONE\n\nnormal', '/native after change', 'ROLE_TWO\n\nchanged normal']);
  });

  it('skips the prefix only for the exact catalog-supported provider-delivered native plan marker', async () => {
    const marker: AgentSessionStartupInstructionsMarkerV1 = { v: 1, id: 'coding.session-plan', revision: 2 };
    expect(await dispatchPlans([
      { text: 'capability alone', plan: 'ROLE', deliveryState: { marker, startupInstructionsSupported: true } },
      { text: 'native accepted', plan: 'ROLE', deliveryState: { marker, startupInstructionsSupported: true, nativeDeliveredMarker: marker } },
      { text: 'new revision pending', plan: 'ROLE_CHANGED', deliveryState: {
        marker: { ...marker, revision: 3 }, startupInstructionsSupported: true, nativeDeliveredMarker: marker,
      } },
    ])).toEqual(['ROLE\n\ncapability alone', 'native accepted', `${supersedingPlan('ROLE_CHANGED')}\n\nnew revision pending`]);
  });
});
