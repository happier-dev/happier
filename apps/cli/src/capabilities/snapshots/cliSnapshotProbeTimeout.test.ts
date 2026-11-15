import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveCliSnapshotProbeTimeoutMs } from './cliSnapshotProbeTimeout';

afterEach(() => vi.unstubAllEnvs());

describe('CLI snapshot probe timeout environment', () => {
    it('keeps implicit and captured budgets with the invoking Session', async () => {
        vi.stubEnv('HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS', '9000');
        vi.stubEnv('HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS', '9500');
        const environments = [
            { NODE_ENV: 'test' as const, HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS: '1250', HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS: '2500' },
            { NODE_ENV: 'test' as const, CI: '1' },
        ];
        const observations = await Promise.all(environments.map((environment) => runAddedHostedSession({
            environment, workingDirectory: process.cwd(), end() {},
        }, async () => {
            await Promise.resolve();
            return {
                fast: resolveCliSnapshotProbeTimeoutMs(false),
                slow: resolveCliSnapshotProbeTimeoutMs(true),
                deferred: () => resolveCliSnapshotProbeTimeoutMs(true, environment),
            };
        })));

        expect(observations.map(({ fast, slow }) => ({ fast, slow }))).toEqual([
            { fast: 1250, slow: 2500 }, { fast: 3000, slow: 7000 },
        ]);
        expect(observations.map(({ deferred }) => deferred())).toEqual([2500, 7000]);
        expect(resolveCliSnapshotProbeTimeoutMs(true, {
            NODE_ENV: 'test',
            HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS: '1234.5',
            HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS: '-1',
        })).toBe(1234.5);
        expect(resolveCliSnapshotProbeTimeoutMs(true, { NODE_ENV: 'test' })).toBe(6500);
        expect(resolveCliSnapshotProbeTimeoutMs(true)).toBe(9500);
    });
});
