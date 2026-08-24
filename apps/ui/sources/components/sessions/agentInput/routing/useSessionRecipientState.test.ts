import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { existingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import { writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { useSessionRecipientState } from './useSessionRecipientState';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
const activeScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-a', accountId: 'account-a' } as ServerAccountScope | null,
}));
let scopeSequence = 0;

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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookValue = ReturnType<typeof useSessionRecipientState>;

function target(recipient: ParticipantRecipientV1, label = 'x'): SessionParticipantTarget {
    const key = `${recipient.kind}:${(recipient as any).runId ?? (recipient as any).memberId ?? (recipient as any).teamId}`;
    return { key, displayLabel: label, recipient };
}

function getActiveScope(): ServerAccountScope {
    const scope = activeScopeState.value;
    if (!scope) throw new Error('Expected an active server account scope');
    return scope;
}

describe('useSessionRecipientState', () => {
    beforeEach(() => {
        mmkvStore.clear();
        activeScopeState.value = { serverId: 'server-a', accountId: `account-${scopeSequence++}` };
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
        expect((hook.getCurrent() as any).executionRunDelivery).toBe('steer_if_supported');

        await act(async () => {
            (hook.getCurrent() as any).setExecutionRunDelivery('interrupt');
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect((hook.getCurrent() as any).executionRunDelivery).toBe('interrupt');
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
        existingSessionDraftSemanticValues.write(getActiveScope(), 'session-a', 'routing.recipient', persisted);
        const targets = [target(auto), target(persisted)];

        const hook = await renderHook(
            ({ nextTargets }: { nextTargets: SessionParticipantTarget[] }) =>
                useSessionRecipientState({
                    targets: nextTargets,
                    autoRecipient: auto,
                    draftPersistence: {
                        sessionId: 'session-a',
                        surface: 'mainComposer',
                    },
                }),
            {
                initialProps: { nextTargets: targets },
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
        existingSessionDraftSemanticValues.write(getActiveScope(), 'session-a', 'routing.recipient', persisted);
        let renderCount = 0;

        const hook = await renderHook(
            () => {
                renderCount += 1;
                return useSessionRecipientState({
                    targets,
                    autoRecipient: null,
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
        existingSessionDraftSemanticValues.write(getActiveScope(), 'session-a', 'routing.recipient', persisted);
        let renderCount = 0;

        const hook = await renderHook(
            () => {
                renderCount += 1;
                if (renderCount > 20) throw new Error('recipient hydration feedback loop');
                return useSessionRecipientState({
                    targets: [{ ...persistedTarget }],
                    autoRecipient: null,
                    draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
                });
            },
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        expect(renderCount).toBeLessThan(10);
        expect(hook.getCurrent().recipient).toEqual(persisted);
        await hook.unmount();
    });

    it('restores an explicit manual Session recipient instead of applying auto-recipient', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_auto' };
        const targets = [target(auto)];
        existingSessionDraftSemanticValues.write(getActiveScope(), 'session-a', 'routing.recipient', null);

        const hook = await renderHook(
            () => useSessionRecipientState({
                targets,
                autoRecipient: auto,
                draftPersistence: { sessionId: 'session-a', surface: 'mainComposer' },
            }),
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        expect(hook.getCurrent().didManualOverride).toBe(true);
        expect(hook.getCurrent().recipient).toBeNull();
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
        existingSessionDraftSemanticValues.write(getActiveScope(), 'session-a', 'routing.recipient', persisted);

        const hook = await renderHook(
            ({ nextTargets }: { nextTargets: SessionParticipantTarget[] }) =>
                useSessionRecipientState({
                    targets: nextTargets,
                    autoRecipient: auto,
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

    it('hydrates persisted delivery and falls back when the next Session has no delivery override', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        const targets = [target(auto)];
        existingSessionDraftSemanticValues.write(getActiveScope(), 'session-a', 'routing.executionRunDelivery', 'interrupt');

        const hook = await renderHook(
            ({ sessionId }: { sessionId: string }) =>
                useSessionRecipientState({
                    targets,
                    autoRecipient: auto,
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

        expect(hook.getCurrent().executionRunDelivery).toBe('interrupt');

        await hook.rerender({ sessionId: 'session-b' });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent().executionRunDelivery).toBe('steer_if_supported');
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
                draftPersistence: {
                    sessionId: 'session-a',
                    surface: 'mainComposer',
                },
            }),
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        await act(async () => {
            hook.getCurrent().setManualRecipient(manual);
            hook.getCurrent().setExecutionRunDelivery('prompt');
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(existingSessionDraftSemanticValues.read(getActiveScope(), 'session-a', 'routing.recipient')).toEqual(manual);
        expect(existingSessionDraftSemanticValues.read(getActiveScope(), 'session-a', 'routing.executionRunDelivery')).toBe('prompt');
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
            hook.getCurrent().setExecutionRunDelivery('interrupt');
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(existingSessionDraftSemanticValues.read(getActiveScope(), 'session-a', 'routing.recipient')).toBeUndefined();
        expect(existingSessionDraftSemanticValues.read(getActiveScope(), 'session-a', 'routing.executionRunDelivery')).toBeUndefined();
        await hook.unmount();
    });
});
