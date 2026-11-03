import { describe, expect, it } from 'vitest';

import { buildStaleSessionRunnerNoticePresentation, readRestartResultBodyKey } from './staleSessionRunnerNoticePresentation';

const runtimeState = {
    v: 1,
    sessionId: 's1',
    machineId: 'm1',
    daemonId: 'd1',
    observedAtMs: 1_700_000_000_000,
    runner: {
        pid: 123,
        runtimeId: 'runner-runtime-old',
        cliVersion: '1.0.0',
        entrypointVersion: 'entry-old',
        processCommandHash: 'hash-old',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
    },
    daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'runner-runtime-new',
        currentEntrypointSource: 'packaged_runtime',
    },
    versionState: 'stale',
    statusSource: 'daemon_tracking',
    plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
    },
} as const;

const translate = (key: string) => key;

describe('stale session runner notice presentation', () => {
    it.each([
        ['runner_not_active', 'runnerUnavailableBody'],
        ['unsupported_daemon', 'updateDaemonBody'],
        ['partial_failure', 'statusFailedBody'],
    ] as const)('offers recovery guidance for %s', (status, key) => {
        expect(readRestartResultBodyKey({ ok: false, sessionId: 's1', status }))
            .toBe(`session.staleRunner.banner.${key}`);
    });
    it.each(['eligibility', 'result'] as const)('offers Stop and Resume guidance for unsupported restart %s', source => {
        const presentation = buildStaleSessionRunnerNoticePresentation({
            runtimeState: source === 'eligibility' ? { ...runtimeState,
                plannedRestart: { supported: true, eligible: false, disabledReason: 'restart_admission_unsupported' },
            } : runtimeState,
            operationStatus: source === 'result' ? { kind: 'result', result: { ok: false,
                sessionId: 's1', status: 'restart_admission_unsupported', reasonCode: 'restart_admission_unsupported' } } : null,
            translate,
        });
        expect(presentation?.banner).toMatchObject({
            body: 'session.staleRunner.banner.stopAndResumeBody',
            actionLabel: 'common.unavailable',
            disabled: true,
        });
    });
    it('builds a warning banner and status badge for actionable stale runner state', () => {
        const presentation = buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: null,
            translate,
        });

        expect(presentation).toEqual(expect.objectContaining({
            fingerprint: 'session-runner:s1:123:hash-old:runner-runtime-old:runner-runtime-new',
            banner: expect.objectContaining({
                testID: 'session-staleRunner-version',
                actionTestID: 'session-staleRunner-restart',
                actionLabel: 'session.staleRunner.actions.restart',
                disabled: false,
            }),
            statusBadge: expect.objectContaining({
                key: 'stale-session-runner',
                testID: 'session-staleRunner-status-badge',
                label: 'session.staleRunner.status.stale',
                tone: 'warning',
            }),
        }));
    });

    it('resets collapse identity when the daemon target entrypoint changes', () => {
        const first = buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: null,
            translate,
        });
        const second = buildStaleSessionRunnerNoticePresentation({
            runtimeState: {
                ...runtimeState,
                daemon: {
                    ...runtimeState.daemon,
                    currentEntrypointVersion: 'runner-runtime-newer',
                },
            },
            operationStatus: null,
            translate,
        });

        expect(first?.fingerprint).not.toBe(second?.fingerprint);
    });

    it('preserves collapse identity when restart availability changes for the same stale runner', () => {
        const available = buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: null,
            translate,
        });
        const busy = buildStaleSessionRunnerNoticePresentation({
            runtimeState: {
                ...runtimeState,
                plannedRestart: { supported: true, eligible: false, disabledReason: 'turn_in_progress' },
            },
            operationStatus: null,
            translate,
        });

        expect(available?.fingerprint).toBe(busy?.fingerprint);
    });

    it('marks pending restarts as busy and disabled while failed/busy results remain actionable', () => {
        expect(buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: { kind: 'pending' },
            translate,
        })?.banner).toEqual(expect.objectContaining({
            actionBusy: true,
            disabled: true,
        }));

        const busy = buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: { kind: 'result', result: { ok: false, status: 'busy', sessionId: 's1' } },
            translate,
        });

        expect(busy?.banner.body).toBe('session.staleRunner.banner.busyBody');
        expect(busy?.banner.disabled).toBe(false);
        expect(busy?.statusBadge.label).toBe('session.staleRunner.status.busy');
    });

    it('keeps stale visible but disables restart while busy or unavailable', () => {
        expect(buildStaleSessionRunnerNoticePresentation({
            runtimeState: { ...runtimeState, versionState: 'current' },
            operationStatus: null,
            translate,
        })).toBeNull();
        const busy = buildStaleSessionRunnerNoticePresentation({
            runtimeState: {
                ...runtimeState,
                plannedRestart: { supported: true, eligible: false, disabledReason: 'approval_pending' },
            },
            operationStatus: null,
            translate,
        });
        expect(busy?.banner).toEqual(expect.objectContaining({
            body: 'session.staleRunner.banner.busyBody',
            actionLabel: 'session.staleRunner.actions.restart',
            disabled: true,
        }));
        expect(busy?.statusBadge.label).toBe('session.staleRunner.status.busy');

        const unavailable = buildStaleSessionRunnerNoticePresentation({
            runtimeState: {
                ...runtimeState,
                plannedRestart: { supported: false, eligible: false, disabledReason: 'unsupported_backend' },
            },
            operationStatus: null,
            translate,
        });
        expect(unavailable?.banner).toEqual(expect.objectContaining({
            body: 'session.staleRunner.banner.unavailableBody',
            actionLabel: 'common.unavailable',
            disabled: true,
        }));
        expect(unavailable?.statusBadge.label).toBe('session.staleRunner.status.stale');
    });
});
