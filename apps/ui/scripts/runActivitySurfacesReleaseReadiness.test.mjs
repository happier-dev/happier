import test from 'node:test';
import assert from 'node:assert/strict';

import { runActivitySurfacesReleaseReadiness } from './runActivitySurfacesReleaseReadiness.mjs';

test('runActivitySurfacesReleaseReadiness runs rollout-local certification before the full apps/ui typecheck', () => {
    const recordedCalls = [];

    const report = runActivitySurfacesReleaseReadiness({
        cwd: '/tmp/happier-ui',
        runRolloutCertification({ cwd, env, spawnSyncImpl }) {
            spawnSyncImpl(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['-s', 'certify:activity-surfaces'], {
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
                command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
                args: ['-s', 'certify:activity-surfaces'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
                args: ['-s', 'typecheck'],
                cwd: '/tmp/happier-ui',
            },
        ],
    );

    assert.deepEqual(report, {
        lane: 'release_readiness',
        includedChecks: [
            'certify:activity-surfaces',
            'apps/ui typecheck',
        ],
        excludedChecks: [
            'test:native-e2e:activity-surfaces',
            'validate:ios:widgets:native-sync',
            'validate:ios:widgets:generated-project',
            'validate:ios:widgets:simulator-build-smoke',
            'cargo_check',
            'cargo_test_activity_overlay',
            'live_manual_qa',
        ],
    });
});
