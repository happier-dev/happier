import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
    writeSessionDraftValue,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
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

const SCOPE: ServerAccountScope = { serverId: 'server-1', accountId: 'account-1' };

function entry(
    backendId: string,
    overrides: Partial<ResolvedBackendCatalogEntry> = {},
): ResolvedBackendCatalogEntry {
    return {
        backendTarget: { kind: 'backend', backendId },
        backendTargetKey: `backend:${backendId}`,
        kind: 'builtInAgent',
        backendId,
        agentId: backendId,
        catalogAgentId: backendId as ResolvedBackendCatalogEntry['catalogAgentId'],
        builtInAgentId: backendId as ResolvedBackendCatalogEntry['builtInAgentId'],
        iconAgentId: backendId as ResolvedBackendCatalogEntry['iconAgentId'],
        title: backendId === 'claude' ? 'Claude Code' : backendId,
        subtitle: null,
        ...overrides,
    };
}

const supportedSource: SessionAgentContinuationSourceState = {
    currentBackendTargetKey: 'backend:claude',
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

const CURRENT_AGENT_ROW = { id: 'engine:claude', label: 'Claude Code', renderDetailContent: () => null };

function readPersistedArm(): SessionArmedAgentContinuation | undefined {
    return readSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation');
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
        resetSessionDraftValueCachesForTests();
        announceAccessibilityMessage.mockClear();
        machineRpcWithServerScope.mockReset();
        machineRpcWithServerScope.mockResolvedValue(AVAILABLE);
    });

    afterEach(() => {
        resetSessionDraftValueCachesForTests();
    });

    it('keeps the armed Agent across a remount, exactly as the draft text already survives one', async () => {
        const first = await renderControls();
        await armTarget(first, 'backend:codex');
        expect(first.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        await first.unmount();

        // Navigating away and back is a fresh mount: nothing in memory survives it.
        const second = await renderControls();

        expect(second.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(second.getCurrent().agentPickerSelectedOptionId).toBe('backend:codex');
    });

    // The identity is the daemon's dedupe key and the divider correlation key.
    // Re-minting it on a remount is how a retry of ONE armed switch committed a
    // second message and a second divider for a cutover that may already have
    // happened.
    it('retains the submitted identity when the same armed switch comes back', async () => {
        const first = await renderControls();
        await armTarget(first, 'backend:codex');
        const submittedLocalId = first.getCurrent().armedContinuationLocalId;
        expect(submittedLocalId).toEqual(expect.any(String));
        // The pre-RPC snapshot stays with the arm, not in a second persisted
        // transition record with a competing lifetime.
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
                    composerAttachments: [],
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
        await armTarget(hook, 'backend:codex');
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
                    composerAttachments: [],
                    attachmentDraftIds: [],
                },
            })).toBe(true);
        });

        await armTarget(hook, 'backend:gemini');

        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('gemini'));
        expect(hook.getCurrent().armedContinuationLocalId).toEqual(expect.any(String));
        expect(hook.getCurrent().armedContinuationLocalId).not.toBe(submittedLocalId);
    });

    it('asks the machine for a Session that is already armed, without waiting for the chip', async () => {
        // The reader armed this Session in an earlier mount. Waiting for them to
        // reach for the Agent chip again would leave the composer promising a
        // continuation whose rail has not been decided.
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'backend:codex',
            intent: armedIntentFor('codex'),
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
        await armTarget(first, 'backend:codex');
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
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'backend:codex',
            intent: armedIntentFor('codex'),
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
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'backend:gemini',
            intent: armedIntentFor('gemini'),
        });

        const hook = await renderControls({
            currentAgentId: 'codex',
            source: { ...supportedSource, currentBackendTargetKey: 'backend:codex' },
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });

    it('keeps the submitted snapshot when a successful switch makes its old arm ineligible', async () => {
        const submittedLocalId = 'submitted-for-codex';
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'backend:codex',
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
                    composerAttachments: [],
                    attachmentDraftIds: [],
                },
            },
        });

        // The transition was admitted while this screen was unmounted. Codex is
        // now current, so the old Claude→Codex arm is no longer a promise about
        // the next message; its nested submission still needs custody recovery.
        const hook = await renderControls({
            currentAgentId: 'codex',
            source: { ...supportedSource, currentBackendTargetKey: 'backend:codex' },
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

    it('leaves a persisted arm alone while its feature decision is unresolved', async () => {
        // An unresolved decision fails closed for the rail, but it is not proof
        // a saved arm is stale. It simply is not restored until the canonical
        // decision answers.
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'backend:codex',
            intent: armedIntentFor('codex'),
        });

        const hook = await renderControls({ featureDecision: null });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeDefined();
    });

    it('keeps an arm through a daemon reinspection that remains eligible', async () => {
        const hook = await renderControls();
        await armTarget(hook, 'backend:codex');
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
        await armTarget(hook, 'backend:codex');
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
        await armTarget(hook, 'backend:codex');
        expect(readPersistedArm()).toBeDefined();

        // Every target refused: the rail is gone, and with it the only gesture that
        // could cancel the arm. A persisted arm here would come back uncancellable.
        await hook.rerender({ source: { ...supportedSource, machinePresence: 'offline' } });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });
});
