import { describe, expect, it } from 'vitest';

import type { HappierService } from '../types.js';
import { buildBackgroundServiceRepairPlan } from './backgroundServiceRepair.js';

function createDaemonService(overrides: Partial<HappierService> = {}): HappierService {
    return {
        id: 'service:stable:default',
        serviceType: 'daemon',
        platform: 'linux',
        backend: 'systemd-user',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
        verification: 'verified',
        ring: 'stable',
        instanceId: 'default',
        scope: 'user',
        definitionPath: '/home/test/.config/systemd/user/happier-daemon.default.service',
        executablePath: '/home/test/.happier/bin/happier',
        installed: true,
        running: true,
        ...overrides,
    };
}

describe('buildBackgroundServiceRepairPlan', () => {
    it('does not remove default-following services with missing Happier home metadata from another release channel', () => {
        const plan = buildBackgroundServiceRepairPlan({
            currentReleaseChannel: 'preview',
            preferredMode: 'user',
            services: [
                createDaemonService({
                    ring: 'stable',
                    happierHomeDir: null,
                }),
            ],
        });

        expect(plan.actions).toEqual([]);
        expect(plan.manualWarnings).toEqual([
            expect.stringContaining('missing Happier home metadata'),
        ]);
    });
});
