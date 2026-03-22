import { describe, expect, it } from 'vitest';

import { resolveParticipantRoutingDescriptor, resolveParticipantRoutedSend } from './resolveParticipantRoutedSend';

describe('resolveParticipantRoutedSend', () => {
    it('returns null for routing descriptors when the live target set does not contain the recipient', () => {
        const descriptor = resolveParticipantRoutingDescriptor({
            recipient: { kind: 'execution_run', runId: 'run_1' },
            targets: [],
        });

        expect(descriptor).toBeNull();
    });

    it('resolves execution run routing descriptors from live participant targets', () => {
        const descriptor = resolveParticipantRoutingDescriptor({
            recipient: { kind: 'execution_run', runId: 'run_1' },
            targets: [
                {
                    key: 'run-1',
                    displayLabel: 'Run 1',
                    recipient: { kind: 'execution_run', runId: 'run_1' },
                },
            ],
        });

        expect(descriptor).toEqual({
            type: 'execution_run_send',
            recipient: { kind: 'execution_run', runId: 'run_1' },
            runId: 'run_1',
        });
    });

    it('routes agent team recipients to a session message with participant_message.v1 meta', () => {
        const outbound = resolveParticipantRoutedSend({
            text: 'hello',
            recipient: { kind: 'agent_team_member', teamId: 'probe', memberId: 'alpha@probe' },
        });
        expect(outbound.type).toBe('session_message');
        expect((outbound as any).text).toBe('hello');
        expect((outbound as any).metaOverrides?.happier?.kind).toBe('participant_message.v1');
        expect((outbound as any).metaOverrides?.happier?.payload?.recipient?.kind).toBe('agent_team_member');
    });

    it('routes execution runs to execution.run.send with delivery=steer_if_supported', () => {
        const outbound = resolveParticipantRoutedSend({
            text: 'steer',
            recipient: { kind: 'execution_run', runId: 'run_1' },
        });
        expect(outbound.type).toBe('execution_run_send');
        expect((outbound as any).runId).toBe('run_1');
        expect((outbound as any).delivery).toBe('steer_if_supported');
    });

    it('allows overriding execution-run delivery mode', () => {
        const outbound = resolveParticipantRoutedSend({
            text: 'interrupt',
            recipient: { kind: 'execution_run', runId: 'run_2' },
            executionRunDelivery: 'interrupt',
        });
        expect(outbound.type).toBe('execution_run_send');
        expect((outbound as any).runId).toBe('run_2');
        expect((outbound as any).delivery).toBe('interrupt');
    });
});
