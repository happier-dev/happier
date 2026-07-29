import { describe, expect, it } from 'vitest';

import { buildStaleSessionRunnerNoticePresentation } from './staleSessionRunnerNoticePresentation';

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
    it('builds a warning banner and status badge for actionable stale runner state', () => {
        const presentation = buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: null,
            translate,
        });

        expect(presentation).toEqual(expect.objectContaining({
            fingerprint: 'session-runner:s1:123:hash-old:runner-runtime-old:runner-runtime-new:eligible',
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

    it('marks pending restarts as disabled and failed/busy restarts as still actionable', () => {
        expect(buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: { kind: 'pending' },
            translate,
        })?.banner.disabled).toBe(true);

        const busy = buildStaleSessionRunnerNoticePresentation({
            runtimeState,
            operationStatus: { kind: 'result', result: { ok: false, status: 'busy', sessionId: 's1' } },
            translate,
        });

        expect(busy?.banner.body).toBe('session.staleRunner.banner.busyBody');
        expect(busy?.banner.disabled).toBe(false);
        expect(busy?.statusBadge.label).toBe('session.staleRunner.status.busy');
    });

    it('fails closed for current or ineligible runtime states', () => {
        expect(buildStaleSessionRunnerNoticePresentation({
            runtimeState: { ...runtimeState, versionState: 'current' },
            operationStatus: null,
            translate,
        })).toBeNull();
        expect(buildStaleSessionRunnerNoticePresentation({
            runtimeState: {
                ...runtimeState,
                plannedRestart: { supported: true, eligible: false, disabledReason: 'approval_pending' },
            },
            operationStatus: null,
            translate,
        })).toBeNull();
    });
});
