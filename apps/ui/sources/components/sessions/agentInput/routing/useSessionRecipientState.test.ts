import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

import { useSessionRecipientState } from './useSessionRecipientState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookValue = ReturnType<typeof useSessionRecipientState>;

function target(recipient: ParticipantRecipientV1, label = 'x'): SessionParticipantTarget {
    const key = `${recipient.kind}:${(recipient as any).runId ?? (recipient as any).memberId ?? (recipient as any).teamId}`;
    return { key, displayLabel: label, recipient };
}

describe('useSessionRecipientState', () => {
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
});
