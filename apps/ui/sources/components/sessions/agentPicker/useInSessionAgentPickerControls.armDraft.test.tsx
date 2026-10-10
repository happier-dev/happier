import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
    writeSessionDraftValue,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import {
    SessionArmedAgentContinuationSubmissionSchema,
    type SessionArmedAgentContinuation,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

import {
    useInSessionAgentPickerControls,
    type SessionAgentContinuationFeatureDecision,
} from './useInSessionAgentPickerControls';
import type {
    SessionAgentContinuationMachineTarget,
    SessionAgentContinuationSourceState,
} from './resolveSessionAgentContinuationEligibility';
import { prepareArmedAgentContinuation } from '@/sync/domains/session/input/continueSessionWithArmedAgent';
import { MetadataSchema } from '@happier-dev/session-core/state';

const announceAccessibilityMessage = vi.hoisted(() => vi.fn());
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

// These contracts observe draft custody and row identity, not translated copy.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/text/i18n', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        setPreferredLanguageFromSettings: () => {},
        areTranslationsReadyForSettings: () => true,
        preloadTranslationsForSettings: async () => {},
    };
});

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

const SCOPE: ServerAccountScope = { serverId: 'server-1', accountId: 'account-1' };

function entry(
    backendId: string,
    overrides: Partial<ResolvedBackendCatalogEntry> = {},
): ResolvedBackendCatalogEntry {
    const resolved = getResolvedBackendCatalogEntries({
        enabledAgentIds: [backendId],
        acpCatalogSettingsV1: { v: 2, backends: [] },
    }).find((candidate) => candidate.agentId === backendId);
    if (!resolved) throw new Error(`Missing Agent catalog fixture for ${backendId}`);
    return {
        ...resolved,
        ...overrides,
    };
}

const supportedSource: SessionAgentContinuationSourceState = {
    currentBackendTargetKey: 'agent:happier.agent.claude/claude',
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
        projectionCurrent: true,
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

/** Let the preflight answer, then select a target row. */
async function armTarget(
    hook: Awaited<ReturnType<typeof renderControls>>,
    optionId: string,
): Promise<void> {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
        const option = hook.getCurrent()
            .composeAgentPickerOptions([CURRENT_AGENT_ROW])
            .find((candidate) => candidate.id === optionId);
        if (!option?.onSelectImmediate) throw new Error(`Missing armable Agent row ${optionId}`);
        option.onSelectImmediate();
    });
}

function readTargetOptionIds(hook: Awaited<ReturnType<typeof renderControls>>): string[] {
    return hook.getCurrent()
        .composeAgentPickerOptions([CURRENT_AGENT_ROW])
        .map((option) => option.id)
        .filter((id) => id !== CURRENT_AGENT_ROW.id);
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
        machineRpcWithServerScope.mockImplementation((params: { payload: { selections: readonly unknown[] } }) => (
            Promise.resolve({
                v: 1,
                inspections: params.payload.selections.map(() => AVAILABLE),
            })
        ));
    });

    afterEach(() => {
        resetSessionDraftValueCachesForTests();
    });

    it('keeps the armed Agent across a remount, exactly as the draft text already survives one', async () => {
        const first = await renderControls();
        await armTarget(first, 'agent:happier.agent.codex/codex');
        expect(first.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        await first.unmount();

        // Navigating away and back is a fresh mount: nothing in memory survives it.
        const second = await renderControls();

        expect(second.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(second.getCurrent().agentPickerSelectedOptionId).toBe('agent:happier.agent.codex/codex');
    });

    // The identity is the daemon's dedupe key and the divider correlation key.
    // Re-minting it on a remount is how a retry of ONE armed switch committed a
    // second message and a second divider for a cutover that may already have
    // happened.
    it('retains the submitted identity when the same armed switch comes back', async () => {
        const first = await renderControls();
        await armTarget(first, 'agent:happier.agent.codex/codex');
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
                    meta: { permissionMode: 'yolo' },
                },
                currentness: {
                    text: 'switch and send this',
                    mentions: [],
                    composerAttachments: [],
                    attachmentDraftIds: [],
                },
            })).toBe(true);
        });
        await act(async () => {
            expect(first.getCurrent().recordArmedContinuationSubmission({
                localId: submittedLocalId as string,
                input: { localId: submittedLocalId as string, text: 'newer draft', meta: { permissionMode: 'read-only' } },
                currentness: { text: 'newer draft', mentions: [], composerAttachments: [], attachmentDraftIds: [] },
            })).toBe(true);
        });
        expect(readPersistedArm()?.submission).toMatchObject({
            localId: submittedLocalId,
            input: { text: 'switch and send this', meta: { permissionMode: 'yolo' } },
        });
        await first.unmount();

        const second = await renderControls();

        expect(second.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(second.getCurrent().armedContinuationLocalId).toBe(submittedLocalId);
        expect(second.getCurrent().armedContinuationSubmission).toMatchObject({
            localId: submittedLocalId,
            input: { text: 'switch and send this', meta: { permissionMode: 'yolo' } },
        });
    });

    it('refuses an unsupported permission transfer before retaining a first submitted input', async () => {
        const first = await renderControls();
        await armTarget(first, 'agent:happier.agent.codex/codex');
        const localId = first.getCurrent().armedContinuationLocalId;
        if (!localId) throw new Error('Expected an armed continuation identity');
        machineRpcWithServerScope.mockResolvedValueOnce({ protocolVersion: 1, results: {
            'tool.sessionAgentTransition': { ok: false, checkedAt: 1, error: { code: 'unknown-capability', message: 'Unknown capability' } },
        } });
        const outcome = await prepareArmedAgentContinuation({
            sessionId: 'session-1', serverId: 'server-1', machineId: 'machine-1', localId,
            intent: armedIntentFor('codex'), sourceAgentLabel: 'Claude', targetAgentLabel: 'Codex',
            input: { text: 'still editable', meta: { permissionMode: 'yolo' } },
        }, MetadataSchema.parse({ path: '/repo', host: 'host', permissionMode: 'default' }));
        if (outcome.status === 'ready') {
            first.getCurrent().recordArmedContinuationSubmission({
                localId, input: { localId, text: 'still editable', meta: { permissionMode: 'yolo' } },
                currentness: { text: 'still editable', mentions: [], composerAttachments: [], attachmentDraftIds: [] },
            });
        }
        expect(outcome).toMatchObject({ status: 'refused', reason: 'unsupported_permission_intent' });
        expect(readPersistedArm()).toMatchObject({ intent: armedIntentFor('codex') });
        expect(readPersistedArm()?.submission).toBeUndefined();
        await first.unmount();
        const restored = await renderControls();
        expect(restored.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(restored.getCurrent().armedContinuationSubmission).toBeNull();
    });

    it('mints a fresh identity when a distinct target is armed after a submission', async () => {
        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });
        await armTarget(hook, 'agent:happier.agent.codex/codex');
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

        await armTarget(hook, 'agent:happier.agent.gemini/gemini');

        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('gemini'));
        expect(hook.getCurrent().armedContinuationLocalId).toEqual(expect.any(String));
        expect(hook.getCurrent().armedContinuationLocalId).not.toBe(submittedLocalId);
    });

    it('asks the machine for a Session that is already armed, without waiting for the chip', async () => {
        // The reader armed this Session in an earlier mount. Waiting for them to
        // reach for the Agent chip again would leave the composer promising a
        // continuation whose rail has not been decided.
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'agent:happier.agent.codex/codex',
            intent: armedIntentFor('codex'),
        });

        const hook = await renderControls();

        expect(machineRpcWithServerScope).toHaveBeenCalled();
        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
    });

    it('preflights an unarmed Session without arming anything', async () => {
        const hook = await renderControls();

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeUndefined();
    });

    it('does not resurrect an arm the reader already cancelled', async () => {
        const first = await renderControls();
        await armTarget(first, 'agent:happier.agent.codex/codex');
        // Selecting the running Agent is the cancel gesture.
        await act(async () => {
            first.getCurrent()
                .composeAgentPickerOptions([CURRENT_AGENT_ROW])
                .find((option) => option.id === 'engine:claude')
                ?.onSelectImmediate?.();
        });
        expect(readPersistedArm()).toBeNull();
        await first.unmount();

        const second = await renderControls();
        expect(second.getCurrent().armedContinuation).toBeNull();
    });

    it('clears a persisted arm whose target Agent is no longer eligible instead of restoring it', async () => {
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'agent:happier.agent.codex/codex',
            intent: armedIntentFor('codex'),
        });
        machineRpcWithServerScope.mockImplementation((params: { payload: { selections: readonly { agentId: string }[] } }) => (
            Promise.resolve({
                v: 1,
                inspections: params.payload.selections.map((selection) => (
                    selection.agentId === 'codex' ? UNSUPPORTED : AVAILABLE
                )),
            })
        ));

        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeNull();
    });

    it('clears a persisted arm formed against an Agent the Session no longer runs', async () => {
        // The Session was switched to Codex elsewhere; an arm that names Claude as
        // its source is a promise about a departure that already happened.
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'agent:happier.agent.gemini/gemini',
            intent: armedIntentFor('gemini'),
        });

        const hook = await renderControls({
            currentAgentId: 'codex',
            source: { ...supportedSource, currentBackendTargetKey: 'agent:happier.agent.codex/codex' },
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeNull();
    });

    it('keeps the submitted snapshot when a successful switch makes its old arm ineligible', async () => {
        const submittedLocalId = 'submitted-for-codex';
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'agent:happier.agent.codex/codex',
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
            source: { ...supportedSource, currentBackendTargetKey: 'agent:happier.agent.codex/codex' },
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

    it.each([false, true])('offers the other Agents again once custody consumes the switch (target metadata landed: %s)', async (targetMetadataLanded) => {
        const hook = await renderControls();
        await armTarget(hook, 'agent:happier.agent.codex/codex');
        const submittedLocalId = hook.getCurrent().armedContinuationLocalId;
        const submission = SessionArmedAgentContinuationSubmissionSchema.parse({
            localId: submittedLocalId,
            input: {
                text: 'switch and send this',
                localId: submittedLocalId,
                meta: {},
            },
            currentness: {
                text: 'switch and send this',
                mentions: [],
                composerAttachments: [],
                attachmentDraftIds: [],
            },
        });
        await act(async () => {
            expect(hook.getCurrent().recordArmedContinuationSubmission(submission)).toBe(true);
        });

        // Custody can arrive before the target runtime's metadata projection.
        if (targetMetadataLanded) {
            await hook.rerender({
                currentAgentId: 'codex',
                source: { ...supportedSource, currentBackendTargetKey: 'agent:happier.agent.codex/codex' },
            });
        }
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });
        if (targetMetadataLanded) expect(readTargetOptionIds(hook)).toEqual([]);

        await act(async () => {
            expect(hook.getCurrent().clearArmedContinuationSubmissionIfCurrent(submission)).toBe(true);
        });
        expect(readPersistedArm()).toBeNull();
        expect(hook.getCurrent().armedContinuationSubmission).toBeNull();
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().armedContinuationLocalId).toBeNull();
        expect(readTargetOptionIds(hook)).toEqual([
            targetMetadataLanded ? 'agent:happier.agent.claude/claude' : 'agent:happier.agent.codex/codex',
        ]);
    });

    it('leaves a newer arm alone when custody consumes the submission it replaced', async () => {
        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });
        await armTarget(hook, 'agent:happier.agent.codex/codex');
        const submittedLocalId = hook.getCurrent().armedContinuationLocalId;
        const submission = SessionArmedAgentContinuationSubmissionSchema.parse({
            localId: submittedLocalId,
            input: {
                text: 'switch and send this',
                localId: submittedLocalId,
                meta: {},
            },
            currentness: {
                text: 'switch and send this',
                mentions: [],
                composerAttachments: [],
                attachmentDraftIds: [],
            },
        });
        await act(async () => {
            expect(hook.getCurrent().recordArmedContinuationSubmission(submission)).toBe(true);
        });
        await armTarget(hook, 'agent:happier.agent.gemini/gemini');

        await act(async () => {
            expect(hook.getCurrent().clearArmedContinuationSubmissionIfCurrent(submission)).toBe(false);
        });

        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('gemini'));
        expect(readPersistedArm()?.backendTargetKey).toBe('agent:happier.agent.gemini/gemini');
    });

    it('leaves a persisted arm alone while its feature decision is unresolved', async () => {
        // An unresolved decision fails closed for the rail, but it is not proof
        // a saved arm is stale. It simply is not restored until the canonical
        // decision answers.
        writeSessionDraftValue(SCOPE, 'session-1', 'routing.agentContinuation', {
            backendTargetKey: 'agent:happier.agent.codex/codex',
            intent: armedIntentFor('codex'),
        });

        const hook = await renderControls({ featureDecision: null });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeDefined();
    });

    it('keeps an arm through a daemon reinspection that remains eligible', async () => {
        const hook = await renderControls();
        await armTarget(hook, 'agent:happier.agent.codex/codex');
        const localId = hook.getCurrent().armedContinuationLocalId;
        expect(localId).toEqual(expect.any(String));
        const reinspection = createDeferred<{ v: 1; inspections: readonly (typeof AVAILABLE)[] }>();
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
            reinspection.resolve({ v: 1, inspections: [AVAILABLE] });
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(hook.getCurrent().armedContinuationLocalId).toBe(localId);
        expect(readPersistedArm()).toBeDefined();
    });

    it('clears an arm only after a reconnect reinspection settles unavailable', async () => {
        const hook = await renderControls();
        await armTarget(hook, 'agent:happier.agent.codex/codex');
        const localId = hook.getCurrent().armedContinuationLocalId;
        expect(localId).toEqual(expect.any(String));
        const reinspection = createDeferred<{ v: 1; inspections: readonly (typeof UNSUPPORTED)[] }>();
        machineRpcWithServerScope.mockImplementationOnce(() => reinspection.promise);

        await hook.rerender({ machine: { ...onlineMachine, connectionGeneration: 2 } });
        await act(async () => { await Promise.resolve(); });

        // `checking` is not evidence the arm is stale. Clearing here loses the
        // user's target while the new runtime pair is simply answering.
        expect(hook.getCurrent().armedContinuation).toEqual(armedIntentFor('codex'));
        expect(hook.getCurrent().armedContinuationLocalId).toBe(localId);
        expect(readPersistedArm()).toBeDefined();

        await act(async () => {
            reinspection.resolve({ v: 1, inspections: [UNSUPPORTED] });
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().armedContinuationLocalId).toBeNull();
        expect(readPersistedArm()).toBeNull();
    });

    it('drops the persisted arm with the live one when the rail that could cancel it goes', async () => {
        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });
        await armTarget(hook, 'agent:happier.agent.codex/codex');
        expect(readPersistedArm()).toBeDefined();

        // Every target refused: the rail is gone, and with it the only gesture that
        // could cancel the arm. A persisted arm here would come back uncancellable.
        await hook.rerender({ source: { ...supportedSource, machinePresence: 'offline' } });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readPersistedArm()).toBeNull();
    });
});
