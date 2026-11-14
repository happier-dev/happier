import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { SessionDraftDocumentV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
    writeSessionDraftValue,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import { captureSessionDraftCurrentness, clearSessionDraftCurrentnessLocal, getSessionComposerDraftSnapshot, getSessionDraftSnapshot, readSessionMessagingFromDraft, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { useSessionRecipientState } from './useSessionRecipientState';
import { createScmDiffSummaryResultOperationsWithTransport as createScmDiffSummaryResultOperations } from '@/dev/testkit/harness/scmActionTransport';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookValue = ReturnType<typeof useSessionRecipientState>;

const mmkvStore = vi.hoisted(() => new Map<string, string>());
const activeScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-a', accountId: 'account-a' } as ServerAccountScope | null,
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }

        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }

        delete(key: string) {
            mmkvStore.delete(key);
        }

        getAllKeys() {
            return [...mmkvStore.keys()];
        }

        clearAll() {
            mmkvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useActiveServerAccountScope: () => activeScopeState.value,
    });
});

function target(recipient: ParticipantRecipientV1, label = 'x'): SessionParticipantTarget {
    const key = `${recipient.kind}:${(recipient as any).runId ?? (recipient as any).memberId ?? (recipient as any).teamId}`;
    return { key, displayLabel: label, recipient };
}

function getActiveScope(): ServerAccountScope {
    const scope = activeScopeState.value;
    if (!scope) throw new Error('Expected an active server account scope');
    return scope;
}

const activeAccountLifetime: ServerAccountScopeLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => activeScopeState.value?.serverId === 'server-a'
        && activeScopeState.value.accountId === 'account-a',
    onRetire: () => Object.freeze({ dispose: () => undefined }),
});

describe('useSessionRecipientState', () => {
    it('restores a cross-Session selector independently of the native participant and captured Account', async () => {
        const participant = { kind: 'execution_run', runId: 'native-run' } as const;
        const sessionMessage = { kind: 'ask', target: { selector: 'workers', of: 'session-a', recursive: true } } as const;
        writeExistingSessionDraft({ scope: getActiveScope(), sessionId: 'session-a', patch: {
            text: 'Keep this question', sessionMessaging: sessionMessage,
            routing: { recipient: { mode: 'manual', recipient: participant } },
        }, materializationIntent: 'userEdit' });
        const hook = await renderHook(() => useSessionRecipientState({ targets: [], autoRecipient: null,
            accountLifetime: activeAccountLifetime, draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
        }), { flushOptions: { cycles: 2, turns: 2 } });
        expect(hook.getCurrent().sessionMessage).toEqual(sessionMessage);
        expect(hook.getCurrent().recipient).toEqual(participant);
        await hook.unmount();
        const remounted = await renderHook(() => useSessionRecipientState({ targets: [], autoRecipient: null,
            accountLifetime: activeAccountLifetime, draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
        }), { flushOptions: { cycles: 2, turns: 2 } });
        expect(remounted.getCurrent().sessionMessage).toEqual(sessionMessage);
        await remounted.unmount();
    });

    it('changes and clears cross-Session intent without changing text or the native participant', async () => {
        const participant = { kind: 'execution_run', runId: 'native-run' } as const;
        writeExistingSessionDraft({ scope: getActiveScope(), sessionId: 'session-a', patch: {
            text: 'Keep my draft', routing: { recipient: { mode: 'manual', recipient: participant } },
        } });
        const hook = await renderHook(() => useSessionRecipientState({ targets: [], autoRecipient: null,
            accountLifetime: activeAccountLifetime, draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
        }));
        const readDocument = () => SessionDraftDocumentV1Schema.parse(getSessionDraftSnapshot(getActiveScope(), { kind: 'session', sessionId: 'session-a' })?.document);
        const originalText = readDocument()?.composer.text;
        await act(async () => {
            hook.getCurrent().setSessionMessage({ kind: 'ask', target: { selector: 'manager' }, reply: 'return' });
        });
        expect(hook.getCurrent().sessionMessage).toEqual({ kind: 'ask', target: { selector: 'manager' }, reply: 'return' });
        expect(SessionDraftDocumentV1Schema.safeParse(readDocument()).success).toBe(true);
        await act(async () => { hook.getCurrent().setSessionMessage({ kind: 'post_update' }); });
        expect(readSessionMessagingFromDraft(readDocument())).toEqual({ kind: 'post_update' });
        await act(async () => { hook.getCurrent().clearPersistedSessionMessage(); });
        expect(hook.getCurrent().sessionMessage).toBeNull();
        expect(readDocument()?.extensions.happier?.sessionMessagingV1).toBeUndefined();
        expect(readDocument()?.composer.text).toEqual(originalText);
        expect(hook.getCurrent().recipient).toEqual(participant);
        await hook.unmount();
    });

    it('keeps newer target edits when clearing a submitted draft and clears the exact current selection', async () => {
        const scope = getActiveScope();
        const address = { kind: 'session', sessionId: 'session-a' } as const;
        writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: {
            text: 'Submitted question', sessionMessaging: { kind: 'ask', target: { selector: 'workers' } },
        } });
        const submitted = captureSessionDraftCurrentness({ scope, address });
        writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: {
            sessionMessaging: { kind: 'send', target: { selector: 'manager' } },
        } });
        clearSessionDraftCurrentnessLocal({ scope, address, currentness: submitted });
        const readDocument = () => getSessionDraftSnapshot(scope, address)?.document;
        expect(getSessionComposerDraftSnapshot(scope, address)?.composer.text.value).toBe('');
        expect(readSessionMessagingFromDraft(readDocument())).toEqual({ kind: 'send', target: { selector: 'manager' } });
        const current = captureSessionDraftCurrentness({ scope, address });
        clearSessionDraftCurrentnessLocal({ scope, address, currentness: current });
        expect(readSessionMessagingFromDraft(readDocument())).toBeNull();
    });

    it('does not disclose or mutate the captured Home after it retires and restores the new Home selection', async () => {
        const scopeA = getActiveScope();
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        writeExistingSessionDraft({ scope: scopeA, sessionId: 'session-a', patch: {
            text: 'Home A draft', sessionMessaging: { kind: 'ask', target: { selector: 'workers' } },
        } });
        writeExistingSessionDraft({ scope: scopeB, sessionId: 'session-a', patch: {
            text: 'Home B draft', sessionMessaging: { kind: 'send', target: { selector: 'following' } },
        } });
        const lifetimeB: ServerAccountScopeLifetime = {
            scope: scopeB,
            isCurrent: () => activeScopeState.value?.serverId === scopeB.serverId && activeScopeState.value.accountId === scopeB.accountId,
            onRetire: () => Object.freeze({ dispose: () => undefined }),
        };
        const hook = await renderHook(({ lifetime }: { lifetime: ServerAccountScopeLifetime }) => useSessionRecipientState({
            targets: [], autoRecipient: null, accountLifetime: lifetime,
            draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
        }), { initialProps: { lifetime: activeAccountLifetime } });
        const staleSetter = hook.getCurrent().setSessionMessage;
        const staleClear = hook.getCurrent().clearPersistedSessionMessage;
        activeScopeState.value = scopeB;
        await hook.rerender({ lifetime: activeAccountLifetime });
        expect(hook.getCurrent().sessionMessage).toBeNull();
        await act(async () => {
            staleSetter({ kind: 'post_update' });
            staleClear();
        });
        expect(readSessionMessagingFromDraft(getSessionDraftSnapshot(scopeA, { kind: 'session', sessionId: 'session-a' })?.document))
            .toEqual({ kind: 'ask', target: { selector: 'workers' } });
        await hook.rerender({ lifetime: lifetimeB });
        expect(hook.getCurrent().sessionMessage).toEqual({ kind: 'send', target: { selector: 'following' } });
        expect(getSessionComposerDraftSnapshot(scopeB, { kind: 'session', sessionId: 'session-a' })?.composer.text.value).toBe('Home B draft');
        await hook.unmount();
    });
    beforeEach(() => {
        activeScopeState.value = { serverId: 'server-a', accountId: 'account-a' };
        mmkvStore.clear();
        resetSessionDraftValueCachesForTests();
    });

    afterEach(() => {
        resetSessionDraftValueCachesForTests();
        mmkvStore.clear();
    });

    it('retains a pending seeded walkthrough without falling through to the automatic recipient', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'other-run' };
        const pending = { cwd: '/repo', resultId: 'saved', expectedRevision: 4, startNew: true };
        writeExistingSessionDraft({ scope: getActiveScope(), sessionId: 'session-a',
            patch: { text: 'My question', routing: { recipient: { mode: 'scm_diff_summary', recipient: null, target: pending } } },
            materializationIntent: 'userEdit' });
        const hook = await renderHook(() => useSessionRecipientState({
            targets: [target(auto)], autoRecipient: auto, accountLifetime: activeAccountLifetime,
            draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
        }), { flushOptions: { cycles: 2, turns: 2 } });
        expect(hook.getCurrent().recipient).toBeNull();
        expect(hook.getCurrent()).toMatchObject({ didManualOverride: true, scmDiffSummaryDiscussion: pending });
        await act(async () => {
            hook.getCurrent().setManualRecipient(null);
            await flushHookEffects({ cycles: 2, turns: 2 });
        });
        expect(hook.getCurrent()).toMatchObject({ recipient: null, scmDiffSummaryDiscussion: null });
        expect(getSessionComposerDraftSnapshot(getActiveScope(), { kind: 'session', sessionId: 'session-a' })?.composer.text.value).toBe('My question');
        await hook.unmount();
    });

    it('retains the accepted execution Run before its participant roster arrives', async () => {
        writeExistingSessionDraft({ scope: getActiveScope(), sessionId: 'session-a',
            patch: { routing: { recipient: { mode: 'manual', recipient: { kind: 'execution_run', runId: 'accepted-run' } } } },
            materializationIntent: 'userEdit' });
        const hook = await renderHook(() => useSessionRecipientState({ targets: [], autoRecipient: null,
            accountLifetime: activeAccountLifetime, draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
        }), { flushOptions: { cycles: 2, turns: 2 } });
        expect(hook.getCurrent().recipient).toEqual({ kind: 'execution_run', runId: 'accepted-run' });
        await hook.unmount();
    });

    it('settles a seeded first message onto its accepted Run and preserves drafts on a revision conflict', async () => {
        const targetInput = { cwd: '/repo', resultId: 'saved', expectedRevision: 4, startNew: true };
        const routing = { mode: 'scm_diff_summary', recipient: null, target: targetInput };
        writeExistingSessionDraft({ scope: getActiveScope(), sessionId: 'session-a',
            patch: { text: 'My question', routing: { recipient: routing } }, materializationIntent: 'userEdit' });
        let admitted = false;
        let identifyAcceptedRun = false;
        let changeRecipientWhileAdmitting = false;
        const sent: unknown[] = [];
        const ops = createScmDiffSummaryResultOperations({ sessionId: 'session-a', shouldContinue: () => true,
            composerDraft: activeAccountLifetime,
            rpc: async (_method, input) => {
                sent.push(input);
                if (!admitted) return { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 5 };
                if (changeRecipientWhileAdmitting) writeExistingSessionDraft({ scope: getActiveScope(), sessionId: 'session-a',
                    patch: { text: 'Newer draft', routing: { recipient: { mode: 'manual', recipient: null } } }, materializationIntent: 'userEdit' });
                return { success: true, ...(identifyAcceptedRun ? { runId: 'accepted-run' } : {}), result: { resultId: 'saved', revision: 5, canUndo: false,
                    output: { success: true, resultId: 'saved', revision: 5, runId: 'accepted-run', sourceKey: 'comparison',
                        metadata: { sourceKey: 'comparison', source: { kind: 'workingTree' } },
                        comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                        requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'pending' } },
                        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } } };
            } });
        expect(await ops.discuss({ ...targetInput, message: 'My question' })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
        let document = SessionDraftDocumentV1Schema.parse(getSessionDraftSnapshot(getActiveScope(), { kind: 'session', sessionId: 'session-a' })?.document);
        expect(document.composer.text.value).toBe('My question');
        expect(document.target.kind === 'session' && document.target.routing.recipient.value).toEqual(routing);
        admitted = true;
        expect(await ops.discuss({ ...targetInput, message: 'My question' })).toMatchObject({ success: false, errorCode: 'admission_unknown' });
        document = SessionDraftDocumentV1Schema.parse(getSessionDraftSnapshot(getActiveScope(), { kind: 'session', sessionId: 'session-a' })?.document);
        expect(document.target.kind === 'session' && document.target.routing.recipient.value).toEqual(routing);
        expect(document.composer.text.value).toBe('My question');
        identifyAcceptedRun = true;
        expect(await ops.discuss({ ...targetInput, message: 'My question' })).toMatchObject({ success: true, runId: 'accepted-run' });
        document = SessionDraftDocumentV1Schema.parse(getSessionDraftSnapshot(getActiveScope(), { kind: 'session', sessionId: 'session-a' })?.document);
        expect(document.target.kind === 'session' && document.target.routing.recipient.value).toEqual({ mode: 'manual', recipient: { kind: 'execution_run', runId: 'accepted-run' } });
        expect(document.composer.text.value).toBe('My question');
        expect(sent).toEqual(Array.from({ length: 3 }, () => ({ ...targetInput, message: 'My question' })));
        writeExistingSessionDraft({ scope: getActiveScope(), sessionId: 'session-a',
            patch: { routing: { recipient: routing } }, materializationIntent: 'userEdit' });
        changeRecipientWhileAdmitting = true;
        expect(await ops.discuss({ ...targetInput, message: 'My question' })).toMatchObject({ success: true });
        document = SessionDraftDocumentV1Schema.parse(getSessionDraftSnapshot(getActiveScope(), { kind: 'session', sessionId: 'session-a' })?.document);
        expect(document.target.kind === 'session' && document.target.routing.recipient.value).toEqual({ mode: 'manual', recipient: null });
        expect(document.composer.text.value).toBe('Newer draft');
        expect(await ops.discuss({ ...targetInput, message: 'My question' })).toMatchObject({ success: false, errorCode: 'discussion_unavailable' });
        expect(sent).toHaveLength(4);
    });

    it('defaults execution-run delivery to steer_if_supported and allows overriding', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        const targets = [target(auto)];

        const hook = await renderHook(
            ({ nextTargets, nextAutoRecipient }: { nextTargets: SessionParticipantTarget[]; nextAutoRecipient: ParticipantRecipientV1 }) =>
                useSessionRecipientState({ targets: nextTargets, autoRecipient: nextAutoRecipient }),
            {
                initialProps: { nextTargets: targets, nextAutoRecipient: auto },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );
        expect((hook.getCurrent() as any).executionRunRequestedAction).toEqual({ v: 1, kind: 'enqueue' });

        await act(async () => {
            (hook.getCurrent() as any).setExecutionRunRequestedAction({ v: 1, kind: 'send_now' });
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect((hook.getCurrent() as any).executionRunRequestedAction).toEqual({ v: 1, kind: 'send_now' });
        await hook.unmount();
    });

    it('applies autoRecipient when user has not manually selected a recipient', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        const targets = [target(auto)];
        const hook = await renderHook(
            ({ nextTargets, nextAutoRecipient }: { nextTargets: SessionParticipantTarget[]; nextAutoRecipient: ParticipantRecipientV1 }) =>
                useSessionRecipientState({ targets: nextTargets, autoRecipient: nextAutoRecipient }),
            {
                initialProps: { nextTargets: targets, nextAutoRecipient: auto },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );
        expect(hook.getCurrent().recipient?.kind).toBe('execution_run');
        expect((hook.getCurrent().recipient as any)?.runId).toBe('run_1');
        await hook.unmount();
    });

    it('manual selection wins over autoRecipient', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        const manual: ParticipantRecipientV1 = { kind: 'agent_team_broadcast', teamId: 'probe' };
        const targets = [target(auto), target(manual)];

        const hook = await renderHook(
            ({ nextTargets, nextAutoRecipient }: { nextTargets: SessionParticipantTarget[]; nextAutoRecipient: ParticipantRecipientV1 }) =>
                useSessionRecipientState({ targets: nextTargets, autoRecipient: nextAutoRecipient }),
            {
                initialProps: { nextTargets: targets, nextAutoRecipient: auto },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );
        expect(hook.getCurrent().recipient?.kind).toBe('execution_run');

        await act(async () => {
            hook.getCurrent().setManualRecipient(manual);
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(hook.getCurrent().recipient?.kind).toBe('agent_team_broadcast');
        await hook.unmount();
    });

    it('accepts autoRecipient for agent_team_member when member id matches but team id differs', async () => {
        const targetRecipient: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'repo-inspectors',
            memberId: 'readme-inspector@snoopy-splashing-patterson',
            memberLabel: 'readme-inspector',
        };
        const autoRecipient: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'snoopy-splashing-patterson',
            memberId: 'readme-inspector@snoopy-splashing-patterson',
            memberLabel: 'readme-inspector',
        };

        const hook = await renderHook(
            ({ nextTargets, nextAutoRecipient }: { nextTargets: SessionParticipantTarget[]; nextAutoRecipient: ParticipantRecipientV1 }) =>
                useSessionRecipientState({
                    targets: nextTargets,
                    autoRecipient: nextAutoRecipient,
                }),
            {
                initialProps: { nextTargets: [target(targetRecipient)], nextAutoRecipient: autoRecipient },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );

        expect(hook.getCurrent().recipient?.kind).toBe('agent_team_member');
        expect((hook.getCurrent().recipient as any)?.memberId).toBe('readme-inspector@snoopy-splashing-patterson');
        await hook.unmount();
    });

    it('hydrates a persisted manual recipient for the main composer surface', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_auto' };
        const persisted: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'member_1',
            memberLabel: 'Reviewer',
        };
        writeSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient', persisted);

        const hook = await renderHook(
            ({ nextTargets }: { nextTargets: SessionParticipantTarget[] }) =>
                useSessionRecipientState({
                    targets: nextTargets,
                    autoRecipient: auto,
                    accountLifetime: activeAccountLifetime,
                    draftPersistence: {
                        sessionId: 'session-a',
                        surface: 'mainComposer',
                    },
                }),
            {
                initialProps: { nextTargets: [target(auto), target(persisted)] },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );

        expect(hook.getCurrent().didManualOverride).toBe(true);
        expect(hook.getCurrent().recipient).toEqual(persisted);
        await hook.unmount();
    });

    it('does not rerender routing state for unrelated composer text writes', async () => {
        const persisted: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'member_1',
            memberLabel: 'Reviewer',
        };
        const targets = [target(persisted)];
        writeSessionDraftValue(getActiveScope(), 'session-a', 'routing.recipient', persisted);
        let renderCount = 0;
        const hook = await renderHook(
            () => {
                renderCount += 1;
                return useSessionRecipientState({
                    targets,
                    autoRecipient: null,
                    accountLifetime: activeAccountLifetime,
                    draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
                });
            },
            { flushOptions: { cycles: 2, turns: 2 } },
        );
        const settledRenderCount = renderCount;

        await act(async () => {
            writeExistingSessionDraft({
                scope: getActiveScope(),
                sessionId: 'session-a',
                patch: { text: 'hello world' },
                materializationIntent: 'userEdit',
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(renderCount).toBe(settledRenderCount);
        expect(hook.getCurrent().recipient).toEqual(persisted);
        await hook.unmount();
    });

    it('does not feed persisted recipient hydration back through equivalent target arrays', async () => {
        const persisted: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'member_1',
            memberLabel: 'Reviewer',
        };
        const persistedTarget = target(persisted);
        writeSessionDraftValue(getActiveScope(), 'session-a', 'routing.recipient', persisted);
        let renderCount = 0;
        const hook = await renderHook(
            () => {
                renderCount += 1;
                if (renderCount > 20) throw new Error('recipient hydration feedback loop');
                return useSessionRecipientState({
                    targets: [{ ...persistedTarget }],
                    autoRecipient: null,
                    accountLifetime: activeAccountLifetime,
                    draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
                });
            },
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        expect(renderCount).toBeLessThan(10);
        expect(hook.getCurrent().recipient).toEqual(persisted);
        await hook.unmount();
    });

    it('does not apply an unavailable persisted recipient but restores it when the target reappears', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_auto' };
        const persisted: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'member_1',
            memberLabel: 'Reviewer',
        };
        writeSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient', persisted);

        const hook = await renderHook(
            ({ nextTargets }: { nextTargets: SessionParticipantTarget[] }) =>
                useSessionRecipientState({
                    targets: nextTargets,
                    autoRecipient: auto,
                    accountLifetime: activeAccountLifetime,
                    draftPersistence: {
                        sessionId: 'session-a',
                        surface: 'mainComposer',
                    },
                }),
            {
                initialProps: { nextTargets: [target(auto)] },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );

        expect(hook.getCurrent().recipient).toEqual(auto);

        await hook.rerender({ nextTargets: [target(auto), target(persisted)] });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().didManualOverride).toBe(true);
        expect(hook.getCurrent().recipient).toEqual(persisted);
        await hook.unmount();
    });

    it('hydrates persisted delivery and falls back when the persisted delivery is invalid', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        writeExistingSessionDraft({
            scope: getActiveScope(),
            sessionId: 'session-a',
            patch: { routing: { executionRunRequestedAction: { v: 1, kind: 'send_now' } } },
            materializationIntent: 'userEdit',
        });
        writeExistingSessionDraft({
            scope: getActiveScope(),
            sessionId: 'session-b',
            patch: { routing: { executionRunRequestedAction: 'invalid-delivery' } },
            materializationIntent: 'userEdit',
        });

        const hook = await renderHook(
            ({ sessionId }: { sessionId: string }) =>
                useSessionRecipientState({
                    targets: [target(auto)],
                    autoRecipient: auto,
                    accountLifetime: activeAccountLifetime,
                    draftPersistence: {
                        sessionId,
                        surface: 'mainComposer',
                    },
                }),
            {
                initialProps: { sessionId: 'session-a' },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );

        expect(hook.getCurrent().executionRunRequestedAction).toEqual({ v: 1, kind: 'send_now' });

        await hook.rerender({ sessionId: 'session-b' });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().executionRunRequestedAction).toEqual({ v: 1, kind: 'enqueue' });
        await hook.unmount();
    });

    it('persists manual recipient and delivery changes for the main composer surface', async () => {
        const manual: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'member_1',
            memberLabel: 'Reviewer',
        };
        const hook = await renderHook(
            () => useSessionRecipientState({
                targets: [target(manual)],
                autoRecipient: null,
                accountLifetime: activeAccountLifetime,
                draftPersistence: {
                    sessionId: 'session-a',
                    surface: 'mainComposer',
                },
            }),
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        await act(async () => {
            hook.getCurrent().setManualRecipient(manual);
            hook.getCurrent().setExecutionRunRequestedAction({ v: 1, kind: 'enqueue' });
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient')).toEqual(manual);
        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.executionRunRequestedAction')).toEqual({ v: 1, kind: 'enqueue' });
        await hook.unmount();
    });

    it('persists an explicit manual override to no recipient separately from a missing value', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_auto' };
        const hook = await renderHook(
            () => useSessionRecipientState({
                targets: [target(auto)],
                autoRecipient: auto,
                accountLifetime: activeAccountLifetime,
                draftPersistence: {
                    sessionId: 'session-a',
                    surface: 'mainComposer',
                },
            }),
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        await act(async () => {
            hook.getCurrent().setManualRecipient(null);
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(hook.getCurrent().didManualOverride).toBe(true);
        expect(hook.getCurrent().recipient).toBeNull();
        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient')).toBeNull();

        await hook.unmount();
    });

    it('keeps the message details surface ephemeral when no main-composer persistence is supplied', async () => {
        const manual: ParticipantRecipientV1 = {
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'member_1',
            memberLabel: 'Reviewer',
        };
        const hook = await renderHook(
            () => useSessionRecipientState({
                targets: [target(manual)],
                autoRecipient: null,
            }),
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        await act(async () => {
            hook.getCurrent().setManualRecipient(manual);
            hook.getCurrent().setExecutionRunRequestedAction({ v: 1, kind: 'send_now' });
            hook.getCurrent().setSessionMessage({ kind: 'ask', target: { selector: 'manager' } });
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(hook.getCurrent().sessionMessage).toEqual({ kind: 'ask', target: { selector: 'manager' } });
        expect(getSessionDraftSnapshot(getActiveScope(), { kind: 'session', sessionId: 'session-a' })).toBeNull();
        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient')).toBeUndefined();
        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.executionRunRequestedAction')).toBeUndefined();
        await hook.unmount();
    });
});
