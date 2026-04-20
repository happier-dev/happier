import test from 'node:test';
import assert from 'node:assert/strict';

import { runActivitySurfacesCertification } from './runActivitySurfacesCertification.mjs';

test('runActivitySurfacesCertification runs rollout-local script tests, narrowed typecheck, and focused vitest coverage', () => {
    const recordedCalls = [];

    const report = runActivitySurfacesCertification({
        cwd: '/tmp/happier-ui',
        runVitestSuite({ cwd, env, spawnSyncImpl }) {
            spawnSyncImpl(process.execPath, ['vitest-suite-stub'], {
                cwd,
                env,
                stdio: 'inherit',
            });
        },
        spawnSyncImpl(command, args, options) {
            recordedCalls.push({ command, args, options });
            return {
                status: 0,
                error: undefined,
            };
        },
    });

    assert.deepEqual(
        recordedCalls.map(({ command, args, options }) => ({
            command,
            args,
            cwd: options.cwd,
        })),
        [
            {
                command: process.execPath,
                args: [
                    '--test',
                    './scripts/activitySurfacesValidationContract.test.mjs',
                    './scripts/runActivitySurfacesCertification.test.mjs',
                    './scripts/runActivitySurfacesNativeCertification.test.mjs',
                    './scripts/runActivitySurfacesReleaseReadiness.test.mjs',
                    './scripts/qa/tauriActivitySurfacesMcpQa.test.mjs',
                    './scripts/validateExpoWidgetsNativeSync.test.mjs',
                    './scripts/validateExpoWidgetsGeneratedProject.test.mjs',
                    './scripts/validateExpoWidgetsSimulatorBuildSmoke.test.mjs',
                ],
                cwd: '/tmp/happier-ui',
            },
            {
                command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
                args: ['-s', 'typecheck:activity-surfaces'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: process.execPath,
                args: ['vitest-suite-stub'],
                cwd: '/tmp/happier-ui',
            },
        ],
    );

    assert.deepEqual(report, {
        lane: 'rollout_local',
        includedChecks: [
            'validation_contract_tests',
            'typecheck:activity-surfaces',
            'test:activity-surfaces',
        ],
        excludedChecks: [
            'test:native-e2e:activity-surfaces',
            'validate:ios:widgets:native-sync',
            'validate:ios:widgets:generated-project',
            'validate:ios:widgets:simulator-build-smoke',
            'cargo_check',
            'cargo_test_activity_overlay',
            'apps/ui typecheck',
            'live_manual_qa',
        ],
    });
});
