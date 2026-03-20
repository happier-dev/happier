import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

import { useSessionRecipientState } from './useSessionRecipientState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookValue = ReturnType<typeof useSessionRecipientState>;

async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function renderHook(useValue: () => HookValue): Promise<{ getCurrent: () => HookValue; rerender: () => void; unmount: () => void }> {
    let current: HookValue | null = null;
    function Test() {
        current = useValue();
        return null;
    }
    let root: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        root = renderer.create(React.createElement(Test));
        await flushAsync();
    });
    return {
        getCurrent: () => {
            if (!current) throw new Error('Hook did not render');
            return current;
        },
        rerender: () => {
            if (!root) return;
            act(() => {
                root!.update(React.createElement(Test));
            });
        },
        unmount: () => {
            if (!root) return;
            act(() => {
                root?.unmount();
            });
        },
    };
}

function target(recipient: ParticipantRecipientV1, label = 'x'): SessionParticipantTarget {
    const key = `${recipient.kind}:${(recipient as any).runId ?? (recipient as any).memberId ?? (recipient as any).teamId}`;
    return { key, displayLabel: label, recipient };
}

describe('useSessionRecipientState', () => {
    it('defaults execution-run delivery to steer_if_supported and allows overriding', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        const targets = [target(auto)];

        const hook = await renderHook(() => useSessionRecipientState({ targets, autoRecipient: auto }));
        expect((hook.getCurrent() as any).executionRunDelivery).toBe('steer_if_supported');

        await act(async () => {
            (hook.getCurrent() as any).setExecutionRunDelivery('interrupt');
            await flushAsync();
        });

        expect((hook.getCurrent() as any).executionRunDelivery).toBe('interrupt');
        hook.unmount();
    });

    it('applies autoRecipient when user has not manually selected a recipient', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        const targets = [target(auto)];
        const hook = await renderHook(() => useSessionRecipientState({ targets, autoRecipient: auto }));
        expect(hook.getCurrent().recipient?.kind).toBe('execution_run');
        expect((hook.getCurrent().recipient as any)?.runId).toBe('run_1');
        hook.unmount();
    });

    it('manual selection wins over autoRecipient', async () => {
        const auto: ParticipantRecipientV1 = { kind: 'execution_run', runId: 'run_1' };
        const manual: ParticipantRecipientV1 = { kind: 'agent_team_broadcast', teamId: 'probe' };
        const targets = [target(auto), target(manual)];

        const hook = await renderHook(() => useSessionRecipientState({ targets, autoRecipient: auto }));
        expect(hook.getCurrent().recipient?.kind).toBe('execution_run');

        await act(async () => {
            hook.getCurrent().setManualRecipient(manual);
            await flushAsync();
        });

        expect(hook.getCurrent().recipient?.kind).toBe('agent_team_broadcast');
        hook.unmount();
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

        const hook = await renderHook(() =>
            useSessionRecipientState({
                targets: [target(targetRecipient)],
                autoRecipient,
            }),
        );

        expect(hook.getCurrent().recipient?.kind).toBe('agent_team_member');
        expect((hook.getCurrent().recipient as any)?.memberId).toBe('readme-inspector@snoopy-splashing-patterson');
        hook.unmount();
    });
});
