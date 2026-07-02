import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import { saveRawSessionDraftValues } from '@/sync/domains/state/sessionDraftValuesPersistence';

import { useSessionRecipientState } from './useSessionRecipientState';

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

describe('useSessionRecipientState', () => {
    beforeEach(() => {
        activeScopeState.value = { serverId: 'server-a', accountId: 'account-a' };
        mmkvStore.clear();
        resetSessionDraftValueCachesForTests();
    });

    afterEach(() => {
        resetSessionDraftValueCachesForTests();
        mmkvStore.clear();
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
        writeSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient', persisted);

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
                initialProps: { nextTargets: [target(auto), target(persisted)] },
                flushOptions: { cycles: 2, turns: 2 },
            },
        );

        expect(hook.getCurrent().didManualOverride).toBe(true);
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
        saveRawSessionDraftValues({
            'session-a': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 1,
                    lastEditedAt: 1,
                    value: 'interrupt',
                },
            },
            'session-b': {
                'routing.executionRunDelivery': {
                    v: 1,
                    updatedAt: 1,
                    lastEditedAt: 1,
                    value: 'invalid-delivery',
                },
            },
        }, activeScopeState.value);
        resetSessionDraftValueCachesForTests();

        const hook = await renderHook(
            ({ sessionId }: { sessionId: string }) =>
                useSessionRecipientState({
                    targets: [target(auto)],
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

        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient')).toEqual(manual);
        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.executionRunDelivery')).toBe('prompt');
        await hook.unmount();
    });

    it('persists an explicit manual override to no recipient separately from a missing value', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_auto' };
        const hook = await renderHook(
            () => useSessionRecipientState({
                targets: [target(auto)],
                autoRecipient: auto,
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
            hook.getCurrent().setExecutionRunDelivery('interrupt');
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.recipient')).toBeUndefined();
        expect(readSessionDraftValue(activeScopeState.value, 'session-a', 'routing.executionRunDelivery')).toBeUndefined();
        await hook.unmount();
    });
});
