import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { existingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import type { SessionArmedAgentContinuation } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

import {
    useInSessionAgentPickerControls,
    type SessionAgentContinuationFeatureDecision,
} from './useInSessionAgentPickerControls';
import type {
    SessionAgentContinuationMachineTarget,
    SessionAgentContinuationSourceState,
} from './resolveSessionAgentContinuationEligibility';

const announceAccessibilityMessage = vi.hoisted(() => vi.fn());
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage,
}));

// The socket transport is the genuine system boundary here; everything below it
// — eligibility, the rail decision, the arm scope — stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScope(params),
}));

vi.mock('./buildSessionAgentPickerDetailContent', () => ({
    buildSessionAgentPickerDetailContent: () => null,
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: () => 1,
}));

// Hover-capable throughout: on this host the machine is only asked once the reader
// reaches for the Agent chip, which is the harder case for a restored arm and the
// one that shipped broken. Every case below restores without touching the chip.
vi.mock('@/utils/platform/webMobileHeuristics', () => ({
    isHoverCapablePrimaryPointer: () => true,
}));

let scopeSequence = 0;
let SCOPE: ServerAccountScope = { serverId: 'server-1', accountId: 'account-0' };

function entry(
    agentId: string,
    overrides: Partial<ResolvedBackendCatalogEntry> = {},
): ResolvedBackendCatalogEntry {
    return {
        target: { kind: 'builtInAgent', agentId } as ResolvedBackendCatalogEntry['target'],
        targetKey: `builtInAgent:${agentId}`,
        family: 'builtInAgent',
        providerAgentId: agentId as ResolvedBackendCatalogEntry['providerAgentId'],
        builtInAgentId: agentId as ResolvedBackendCatalogEntry['builtInAgentId'],
        iconAgentId: agentId as ResolvedBackendCatalogEntry['iconAgentId'],
        title: agentId === 'claude' ? 'Claude Code' : agentId,
        subtitle: null,
        ...overrides,
    };
}

const supportedSource: SessionAgentContinuationSourceState = {
    currentBackendTargetKey: 'builtInAgent:claude',
    storageKind: 'persisted',
    canEditSession: true,
    machinePresence: 'online',
    hasConversationToCarry: true,
};

const onlineMachine: SessionAgentContinuationMachineTarget = {
    machineId: 'machine-1',
    serverId: 'server-1',
    connectionGeneration: 1,
    daemonGeneration: 1,
};

const AVAILABLE = {
    type: 'available',
    protocolVersion: 1,
    sameSessionTransition: true,
} as const;

const UNSUPPORTED = {
    type: 'available',
    protocolVersion: 1,
    sameSessionTransition: false,
} as const;

type HookProps = Readonly<{
    currentAgentId?: string | null;
    entries?: readonly ResolvedBackendCatalogEntry[];
    featureDecision?: SessionAgentContinuationFeatureDecision;
    machine?: SessionAgentContinuationMachineTarget;
    source?: SessionAgentContinuationSourceState;
}>;

async function renderControls(props: HookProps = {}) {
    const hook = await renderHook((hookProps: HookProps) => useInSessionAgentPickerControls({
        sessionId: 'session-1',
        accountScope: SCOPE,
        currentAgentId: hookProps.currentAgentId ?? 'claude',
        currentAgentLabel: 'Claude Code',
        currentAgentSessionActive: true,
        entries: hookProps.entries ?? [entry('claude'), entry('codex')],
        featureDecision: hookProps.featureDecision === undefined
            ? { state: 'enabled' }
            : hookProps.featureDecision,
        source: hookProps.source ?? supportedSource,
        machine: hookProps.machine ?? onlineMachine,
        detail: {
            settings: {} as never,
            capabilityServerId: 'server-1',
            machineId: 'machine-1',
            cwd: '/repo',
        },
    }), { initialProps: props });
    // Let the inspections answer so the rail decision is settled.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return hook;
}

const CURRENT_AGENT_ROW = { id: 'engine:claude', label: 'Claude Code', renderDetailContent: () => null };

/** Reach for the Agent chip, let the machine answer, then select a target row. */
async function armTarget(
    hook: Awaited<ReturnType<typeof renderControls>>,
    optionId: string,
): Promise<void> {
    await act(async () => {
        hook.getCurrent().onAgentPickerIntent();
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
        hook.getCurrent()
            .composeAgentPickerOptions([CURRENT_AGENT_ROW])
            .find((option) => option.id === optionId)
            ?.onSelectImmediate?.();
    });
}

function readPersistedArm(): SessionArmedAgentContinuation | undefined {
    return existingSessionDraftSemanticValues.read(SCOPE, 'session-1', 'routing.agentContinuation');
}

function armedIntentFor(targetAgentId: string) {
    return {
        v: 1 as const,
        mode: 'same_session' as const,
        sourceAgentId: 'claude',
        selection: { v: 1 as const, agentId: targetAgentId },
    };
}

function createDeferred<T>() {
    let resolvePromise: ((value: T | PromiseLike<T>) => void) | null = null;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value: T) {
            if (resolvePromise === null) throw new Error('Deferred promise was not initialized');
            resolvePromise(value);
        },
    };
}

describe('useInSessionAgentPickerControls arm draft', () => {
    beforeEach(() => {
        SCOPE = { serverId: 'server-1', accountId: `account-${++scopeSequence}` };
        announceAccessibilityMessage.mockClear();
        machineRpcWithServerScope.mockReset();
        machineRpcWithServerScope.mockResolvedValue(AVAILABLE);
    });

    it('keeps the armed Agent across a remount, exactly as the draft text already survives one', async () => {
        const first = await renderControls();
        await armTarget(first, 'builtInAgent:codex');
        expect(first.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        await first.unmount();

        // Navigating away and back is a fresh mount: nothing in memory survives it.
        const second = await renderControls();

        expect(second.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(second.getCurrent().agentPickerSelectedOptionId).toBe('builtInAgent:codex');
    });

    // The identity is the daemon's dedupe key and the divider correlation key.
    // Re-minting it on a remount is how a retry of ONE armed switch committed a
    // second message and a second divider for a cutover that may already have
    // happened.
    it('retains the submitted identity when the same armed switch comes back', async () => {
        const first = await renderControls();
        await armTarget(first, 'builtInAgent:codex');
        const submittedLocalId = first.getCurrent().armedContinuationLocalId;
        expect(submittedLocalId).toEqual(expect.any(String));
        // The pre-RPC snapshot stays inside the arm rather than in another
        // persisted record with a competing lifetime.
        await act(async () => {
            expect(first.getCurrent().recordArmedContinuationSubmission({
                localId: submittedLocalId as string,
                input: {
                    localId: submittedLocalId as string,
                    text: 'switch and send this',
                    meta: {},
                },
                currentness: {
                    text: 'switch and send this',
                    mentions: [],
                    attachmentDraftIds: [],
                },
            })).toBe(true);
        });
        expect(readPersistedArm()?.submission).toMatchObject({
            localId: submittedLocalId,
            input: { text: 'switch and send this' },
        });
        await first.unmount();

        const second = await renderControls();

        expect(second.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(second.getCurrent().armedContinuationLocalId).toBe(submittedLocalId);
        expect(second.getCurrent().armedContinuationSubmission).toMatchObject({
            localId: submittedLocalId,
            input: { text: 'switch and send this' },
        });
    });

    it('mints a fresh identity when a distinct target is armed after a submission', async () => {
        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });
        await armTarget(hook, 'builtInAgent:codex');
        const submittedLocalId = hook.getCurrent().armedContinuationLocalId;
        expect(submittedLocalId).toEqual(expect.any(String));
        await act(async () => {
            expect(hook.getCurrent().recordArmedContinuationSubmission({
                localId: submittedLocalId as string,
                input: {
                    localId: submittedLocalId as string,
                    text: 'switch and send this',
                    meta: {},
                },
                currentness: {
                    text: 'switch and send this',
                    mentions: [],
                    attachmentDraftIds: [],
                },
            })).toBe(true);
        });

        await armTarget(hook, 'builtInAgent:gemini');

        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('gemini'));
        expect(hook.getCurrent().armedContinuationLocalId).toEqual(expect.any(String));
        expect(hook.getCurrent().armedContinuationLocalId).not.toBe(submittedLocalId);
    });

    it('asks the machine for a Session that is already armed, without waiting for the chip', async () => {
        // The reader armed this Session in an earlier mount. Waiting for them to
        // reach for the Agent chip again would leave the composer promising a
        // continuation whose rail has not been decided.
        existingSessionDraftSemanticValues.write(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'builtInAgent:codex',
            intent: armedIntentFor('codex'),
            modelLabel: null,
        });

        const hook = await renderControls();

        expect(machineRpcWithServerScope).toHaveBeenCalled();
        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
    });

    it('asks nothing for an unarmed Session until the reader reaches for the chip', async () => {
        const hook = await renderControls();

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('does not resurrect an arm the reader already cancelled', async () => {
        const first = await renderControls();
        await armTarget(first, 'builtInAgent:codex');
        // Selecting the running Agent is the cancel gesture.
        await act(async () => {
            first.getCurrent()
                .composeAgentPickerOptions([CURRENT_AGENT_ROW])
                .find((option) => option.id === 'engine:claude')
                ?.onSelectImmediate?.();
        });
        expect(readPersistedArm()).toBeUndefined();
        await first.unmount();

        const second = await renderControls();
        expect(second.getCurrent().armedContinuation).toBeNull();
    });

    it('clears a persisted arm whose target Agent is no longer eligible instead of restoring it', async () => {
        existingSessionDraftSemanticValues.write(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'builtInAgent:codex',
            intent: armedIntentFor('codex'),
            modelLabel: null,
        });
        machineRpcWithServerScope.mockImplementation((params: { payload: { selection: { agentId: string } } }) => (
            Promise.resolve(params.payload.selection.agentId === 'codex' ? UNSUPPORTED : AVAILABLE)
        ));

        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });

    it('clears a persisted arm formed against an Agent the Session no longer runs', async () => {
        // The Session was switched to Codex elsewhere; an arm that names Claude as
        // its source is a promise about a departure that already happened.
        existingSessionDraftSemanticValues.write(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'builtInAgent:gemini',
            intent: armedIntentFor('gemini'),
            modelLabel: null,
        });

        const hook = await renderControls({
            currentAgentId: 'codex',
            source: { ...supportedSource, currentBackendTargetKey: 'builtInAgent:codex' },
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });

    it('keeps the submitted snapshot when a successful switch makes its old arm ineligible', async () => {
        const submittedLocalId = 'submitted-for-codex';
        existingSessionDraftSemanticValues.write(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'builtInAgent:codex',
            intent: armedIntentFor('codex'),
            modelLabel: null,
            submission: {
                localId: submittedLocalId,
                input: {
                    localId: submittedLocalId,
                    text: 'switch and send this',
                    meta: {},
                },
                currentness: {
                    text: 'switch and send this',
                    mentions: [],
                    attachmentDraftIds: [],
                },
            },
        });

        // The daemon admitted the transition while this screen was unmounted, so
        // Codex is now the running Agent and the old Claude→Codex arm cannot be
        // restored as the next-message promise.
        const hook = await renderControls({
            currentAgentId: 'codex',
            source: { ...supportedSource, currentBackendTargetKey: 'builtInAgent:codex' },
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().armedContinuationLocalId).toBeNull();
        expect(hook.getCurrent().armedContinuationSubmission).toMatchObject({
            localId: submittedLocalId,
            input: { text: 'switch and send this' },
        });
        expect(readPersistedArm()?.submission?.localId).toBe(submittedLocalId);
    });

    it('leaves a persisted arm alone while the feature decision is unresolved', async () => {
        // An unresolved decision fails closed for rendering, but is not proof the
        // existing persisted choice became invalid.
        existingSessionDraftSemanticValues.write(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'builtInAgent:codex',
            intent: armedIntentFor('codex'),
            modelLabel: null,
        });

        const hook = await renderControls({ featureDecision: null });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeDefined();
    });

    it('clears a persisted arm when the feature is definitely disabled', async () => {
        existingSessionDraftSemanticValues.write(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'builtInAgent:codex',
            intent: armedIntentFor('codex'),
            modelLabel: null,
        });

        const hook = await renderControls({ featureDecision: { state: 'disabled' } });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });

    it('restores the model the armed row was chosen with, so the engine chip still names it', async () => {
        existingSessionDraftSemanticValues.write(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'builtInAgent:codex',
            intent: { ...armedIntentFor('codex'), selection: { v: 1, agentId: 'codex', modelId: 'gpt-5' } },
            modelLabel: 'GPT-5',
        });

        const hook = await renderControls();

        expect(hook.getCurrent().armedContinuationModelLabel).toBe('GPT-5');
    });

    it('keeps an arm through a daemon reinspection that remains eligible', async () => {
        const hook = await renderControls();
        await armTarget(hook, 'builtInAgent:codex');
        const localId = hook.getCurrent().armedContinuationLocalId;
        expect(localId).toEqual(expect.any(String));
        const reinspection = createDeferred<typeof AVAILABLE>();
        machineRpcWithServerScope.mockImplementationOnce(() => reinspection.promise);

        await hook.rerender({ machine: { ...onlineMachine, daemonGeneration: 2 } });
        await act(async () => { await Promise.resolve(); });

        // A changed daemon invalidates the old answer, not the reader's choice.
        // The choice stays armed until the replacement answer establishes it is
        // no longer honourable.
        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(hook.getCurrent().armedContinuationLocalId).toBe(localId);
        expect(readPersistedArm()).toBeDefined();

        await act(async () => {
            reinspection.resolve(AVAILABLE);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(hook.getCurrent().armedContinuationLocalId).toBe(localId);
        expect(readPersistedArm()).toBeDefined();
    });

    it('clears an arm only after a reconnect reinspection settles unavailable', async () => {
        const hook = await renderControls();
        await armTarget(hook, 'builtInAgent:codex');
        const localId = hook.getCurrent().armedContinuationLocalId;
        expect(localId).toEqual(expect.any(String));
        const reinspection = createDeferred<typeof UNSUPPORTED>();
        machineRpcWithServerScope.mockImplementationOnce(() => reinspection.promise);

        await hook.rerender({ machine: { ...onlineMachine, connectionGeneration: 2 } });
        await act(async () => { await Promise.resolve(); });

        // `checking` is not evidence the arm is stale. Clearing here loses the
        // user's target while the new runtime pair is simply answering.
        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(hook.getCurrent().armedContinuationLocalId).toBe(localId);
        expect(readPersistedArm()).toBeDefined();

        await act(async () => {
            reinspection.resolve(UNSUPPORTED);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().armedContinuationLocalId).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });

    it('drops the persisted arm with the live one when the rail that could cancel it goes', async () => {
        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });
        await armTarget(hook, 'builtInAgent:codex');
        expect(readPersistedArm()).toBeDefined();

        // Every target refused: the rail is gone, and with it the only gesture that
        // could cancel the arm. A persisted arm here would come back uncancellable.
        await hook.rerender({ source: { ...supportedSource, machinePresence: 'offline' } });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });
});
