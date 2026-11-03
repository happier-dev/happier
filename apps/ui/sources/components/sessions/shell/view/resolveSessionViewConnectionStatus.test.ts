import { describe, expect, it } from 'vitest';

import { resolveSessionViewConnectionStatus } from './resolveSessionViewConnectionStatus';
import { canResumeOrContinueSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';
import { resolvePendingActivationBanner } from '@/components/sessions/pending/resolvePendingActivationBanner';
import { writeSessionExplicitStopV1ToMetadata, resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

const baseInput = {
    connectedServicesRestartState: null,
    restartingText: 'restarting connected service',
    switchFailedText: 'switch failed',
    inactiveStatusText: null,
    sessionStatusResuming: false,
    sessionStatusState: 'ready',
    sessionStatusText: 'ready',
    sessionStatusColor: 'status-color',
    sessionStatusDotColor: 'dot-color',
    sessionStatusPulsing: false,
} as const;

describe('resolveSessionViewConnectionStatus', () => {
    it.each([
        { state: 'person stopped', active: false, reachable: true, canWrite: true, resumable: true, expected: 'resume' },
        { state: 'active', active: true, reachable: true, canWrite: true, resumable: true, expected: undefined },
        { state: 'not resumable', active: false, reachable: true, canWrite: true, resumable: false, expected: undefined },
        { state: 'machine unreachable', active: false, reachable: false, canWrite: true, resumable: true, expected: undefined },
        { state: 'read only', active: false, reachable: true, canWrite: false, resumable: true, expected: undefined },
    ])('selects the existing person Resume for an empty stopped queue, preserving $state eligibility', (scenario) => {
        const metadata = writeSessionExplicitStopV1ToMetadata(
            { flavor: scenario.resumable ? 'codex' : 'unknown-agent',
                ...(scenario.resumable ? { codexSessionId: 'native-session-1' } : {}) },
            { v: 1, cause: 'explicit_stop', requestId: 'person-stop-1', requestedAtMs: 1000 },
        );
        // The persisted CLI/UI Stop shape still holds automatic starts. Recovery selection must
        // offer the existing person action without clearing it or fabricating queued input.
        expect(resolveSessionAutoResumeAdmissionV1({ metadata, machineAvailable: true, authorityAvailable: true }))
            .toBe('held_by_person');
        const isResumable = canResumeOrContinueSessionWithOptions(metadata);
        expect(isResumable).toBe(scenario.resumable);
        const inactive = getInactiveSessionUiState({
            isSessionActive: scenario.active, isResumable, isMachineOnline: scenario.reachable,
        });
        const pending = resolvePendingActivationBanner({
            active: scenario.active, activeAt: 0, machineReachable: scenario.reachable,
            canWrite: scenario.canWrite, pendingMessages: [],
        });
        expect(pending).toBeNull();
        const recoveryEligibility = {
            inactiveResumeAvailable: !scenario.active && isResumable && scenario.reachable && scenario.canWrite,
        };
        const status = resolveSessionViewConnectionStatus({
            ...baseInput,
            ...recoveryEligibility,
            sessionStatusState: scenario.active ? 'ready' : 'disconnected',
            sessionUnservable: !scenario.active,
            inactiveStatusText: inactive.inactiveStatusTextKey,
            pendingQueue: { line: null, countText: null },
        });
        expect(status).toMatchObject({ text: inactive.inactiveStatusTextKey ?? 'ready' });
        if (scenario.expected) expect(status).toHaveProperty('inactiveAction', scenario.expected);
        else expect(status).not.toHaveProperty('inactiveAction');
        expect(metadata.sessionExplicitStopV1.requestId).toBe('person-stop-1');
    });

    it.each(['restarting', 'pending_confirmation'] as const)(
        'prioritizes non-terminal connected-service restart state %s as the main status',
        (status) => {
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                inactiveResumeAvailable: true,
                connectedServicesRestartState: {
                    status,
                    attemptId: 'manual-auth-switch:1',
                    reason: 'manual_auth_switch',
                    startedAtMs: 1_000,
                },
            })).toEqual({
                text: 'restarting connected service',
                color: 'status-color',
                dotColor: 'dot-color',
                isPulsing: true,
            });
        },
    );

    it('shows failed restart state only when positive failure evidence reaches the shared state', () => {
        expect(resolveSessionViewConnectionStatus({
            ...baseInput,
            inactiveResumeAvailable: true,
            connectedServicesRestartState: {
                status: 'failed',
                attemptId: 'manual-auth-switch:1',
                reason: 'manual_auth_switch',
                startedAtMs: 1_000,
            },
            inactiveStatusText: 'inactive',
        })).toEqual({
            text: 'switch failed',
            color: 'status-color',
            dotColor: 'dot-color',
            isPulsing: false,
        });
    });

    it('lets the canonical resuming lifecycle override the otherwise inactive session copy', () => {
        expect(resolveSessionViewConnectionStatus({
            ...baseInput,
            inactiveStatusText: 'inactive',
            inactiveResumeAvailable: true,
            sessionStatusResuming: true,
            sessionStatusText: 'resuming',
            sessionStatusPulsing: true,
        })).toEqual({
            text: 'resuming',
            color: 'status-color',
            dotColor: 'dot-color',
            isPulsing: true,
        });
    });

    it('says nothing while the runtime state is still unknown: an "unknown" line is not a status', () => {
        expect(resolveSessionViewConnectionStatus({
            ...baseInput,
            sessionStatusState: 'unknown',
            sessionStatusText: 'unknown',
        })).toBeNull();
    });

    it('still speaks for an unknown runtime when there is a real fact to state', () => {
        expect(resolveSessionViewConnectionStatus({
            ...baseInput,
            sessionStatusState: 'unknown',
            sessionStatusText: 'unknown',
            inactiveStatusText: 'inactive',
        })?.text).toBe('inactive');
        expect(resolveSessionViewConnectionStatus({
            ...baseInput,
            sessionStatusState: 'unknown',
            sessionStatusText: 'unknown',
            connectedServicesRestartState: {
                status: 'restarting',
                attemptId: 'manual-auth-switch:1',
                reason: 'manual_auth_switch',
                startedAtMs: 1_000,
            },
        })?.text).toBe('restarting connected service');
    });

    describe('one line, highest-priority cause wins', () => {
        const providerBinding = {
            text: 'Provider settings changed',
            detail: 'This session is still using the Gateway · Work configuration it started with.',
            action: 'restart',
            color: 'attention-color',
        } as const;
        const restarting = {
            status: 'restarting',
            attemptId: 'manual-auth-switch:1',
            reason: 'manual_auth_switch',
            startedAtMs: 1_000,
        } as const;

        it('states a Provider binding change over the ordinary and inactive status, with its detail and action', () => {
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                inactiveStatusText: 'inactive',
                inactiveResumeAvailable: true,
                providerBinding,
            })).toEqual({
                text: 'Provider settings changed',
                detail: 'This session is still using the Gateway · Work configuration it started with.',
                color: 'attention-color',
                dotColor: 'attention-color',
                isPulsing: false,
                providerBindingAction: 'restart',
            });
        });

        it('speaks for a Provider binding before the runtime has been observed', () => {
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                sessionStatusState: 'unknown',
                sessionStatusText: 'unknown',
                providerBinding,
            })?.text).toBe('Provider settings changed');
        });

        it('keeps the line without an action when the binding offers none the viewer can take', () => {
            const status = resolveSessionViewConnectionStatus({
                ...baseInput,
                providerBinding: { ...providerBinding, action: null },
            });
            expect(status?.text).toBe('Provider settings changed');
            expect(status?.providerBindingAction).toBeUndefined();
        });

        it('yields to a session the machine or runtime cannot serve: that cause comes first', () => {
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                sessionStatusState: 'disconnected',
                sessionStatusText: 'machine offline',
                sessionUnservable: true,
                providerBinding,
            })).toEqual({
                text: 'machine offline',
                color: 'status-color',
                dotColor: 'dot-color',
                isPulsing: false,
            });
        });

        it.each(['permission_required', 'action_required'] as const)(
            'keeps a request visible alongside binding recovery (%s)',
            (state) => {
                const status = resolveSessionViewConnectionStatus({
                    ...baseInput,
                    inactiveResumeAvailable: true,
                    sessionStatusState: state,
                    sessionStatusText: 'Permission required',
                    providerBinding,
                    pendingQueue: { line: null, countText: '1 queued' },
                });
                expect(status?.text).toBe('Permission required · 1 queued');
                expect(status?.providerBindingAction).toBe('restart');
                expect(status).not.toHaveProperty('inactiveAction');
            },
        );

        it.each(['failed', 'permission_required', 'action_required', 'usage_limited', 'stopped'] as const)(
            'keeps canonical %s news ahead of generic inactive copy',
            (state) => {
                const status = resolveSessionViewConnectionStatus({
                    ...baseInput,
                    sessionStatusState: state,
                    sessionStatusText: 'canonical status',
                    sessionUnservable: state === 'failed',
                    inactiveStatusText: 'Inactive (machine offline)',
                    inactiveDetail: 'Machine offline',
                    inactiveResumeAvailable: true,
                });
                expect(status?.text).toBe('canonical status');
                expect(status).not.toHaveProperty('detail');
                if (state === 'permission_required' || state === 'action_required') {
                    expect(status).not.toHaveProperty('inactiveAction');
                }
            },
        );

        it('yields to resuming, a restart in progress and a failed switch', () => {
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                sessionStatusResuming: true,
                sessionStatusText: 'resuming',
                providerBinding,
            })?.text).toBe('resuming');
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                connectedServicesRestartState: restarting,
                providerBinding,
            })?.text).toBe('restarting connected service');
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                connectedServicesRestartState: { ...restarting, status: 'failed' },
                providerBinding,
            })?.text).toBe('switch failed');
        });

        describe('the pending queue', () => {
            const queuedLine = {
                text: 'Message queued',
                detail: 'This inactive session has queued input. Resume it when you are ready.',
                action: 'resume',
                color: 'quiet-color',
            } as const;

            it('states a queued message waiting on an inactive session as the line, with its one action', () => {
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput,
                    inactiveStatusText: 'Inactive (resumable)',
                    inactiveResumeAvailable: true,
                    pendingQueue: { line: queuedLine, countText: '1 queued' },
                })).toEqual({
                    text: 'Message queued',
                    detail: 'This inactive session has queued input. Resume it when you are ready.',
                    color: 'quiet-color',
                    dotColor: 'quiet-color',
                    isPulsing: false,
                    pendingQueueAction: 'resume',
                });
            });

            it('outranks a machine that cannot serve the session, because the queued line already names it', () => {
                const status = resolveSessionViewConnectionStatus({
                    ...baseInput,
                    sessionStatusState: 'disconnected',
                    sessionStatusText: 'machine offline',
                    sessionUnservable: true,
                    providerBinding,
                    pendingQueue: { line: { ...queuedLine, text: 'Machine offline · message queued', action: 'process_when_online' }, countText: null },
                });
                expect(status?.text).toBe('Machine offline · message queued');
                expect(status?.pendingQueueAction).toBe('process_when_online');
                expect(status?.providerBindingAction).toBeUndefined();
            });

            it('yields to resuming, a restart and the guard', () => {
                const pendingQueue = { line: queuedLine, countText: null };
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput, sessionStatusResuming: true, sessionStatusText: 'resuming', pendingQueue,
                })?.text).toBe('resuming');
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput, connectedServicesRestartState: restarting, pendingQueue,
                })?.text).toBe('restarting connected service');
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput,
                    pendingQueue,
                    guard: {
                        state: { kind: 'stopped', text: 'Stopped by the machine guard', placeholder: 'Send to wake it' },
                        attentionColor: 'attention-color',
                        quietColor: 'quiet-color',
                    },
                })?.text).toBe('Stopped by the machine guard');
            });

            it('adds the queue size to an ordinary status instead of a separate header', () => {
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput,
                    sessionStatusState: 'thinking',
                    sessionStatusText: 'Thinking',
                    sessionStatusPulsing: true,
                    pendingQueue: { line: null, countText: '2 queued' },
                })).toEqual({
                    text: 'Thinking · 2 queued',
                    color: 'status-color',
                    dotColor: 'dot-color',
                    isPulsing: true,
                });
            });

            it('carries the inactive cause\'s explanation as the line\'s detail instead of a card', () => {
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput,
                    sessionStatusState: 'disconnected',
                    sessionStatusText: 'machine offline',
                    inactiveStatusText: 'Inactive (machine offline)',
                    inactiveDetail: '“Studio” is offline, so Happier can’t resume this session yet.',
                    sessionUnservable: true,
                })).toEqual({
                    text: 'Inactive (machine offline)',
                    detail: '“Studio” is offline, so Happier can’t resume this session yet.',
                    color: 'status-color',
                    dotColor: 'dot-color',
                    isPulsing: false,
                });
            });

            it('lets resuming speak alone: the resume is what delivers the queue', () => {
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput,
                    sessionStatusResuming: true,
                    sessionStatusText: 'resuming',
                    pendingQueue: { line: null, countText: '1 queued' },
                })?.text).toBe('resuming');
            });

            it('never appends the size to a cause that already owns the line', () => {
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput,
                    providerBinding,
                    pendingQueue: { line: null, countText: '2 queued' },
                })?.text).toBe('Provider settings changed');
            });

            it('states the queue alone while the runtime has not been observed yet', () => {
                expect(resolveSessionViewConnectionStatus({
                    ...baseInput,
                    sessionStatusState: 'unknown',
                    sessionStatusText: 'unknown',
                    pendingQueue: { line: null, countText: '1 queued' },
                })?.text).toBe('1 queued');
            });
        });

        it('yields to the machine guard', () => {
            expect(resolveSessionViewConnectionStatus({
                ...baseInput,
                providerBinding,
                inactiveResumeAvailable: true,
                guard: {
                    state: { kind: 'stopped', text: 'Stopped by the machine guard', placeholder: 'Send to wake it' },
                    attentionColor: 'attention-color',
                    quietColor: 'quiet-color',
                },
            })?.text).toBe('Stopped by the machine guard');
        });
    });
});
