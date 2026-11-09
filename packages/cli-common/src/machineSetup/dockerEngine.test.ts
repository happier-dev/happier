import { describe, expect, it } from 'vitest';
import { MachineRecipeStepV1Schema } from '@happier-dev/protocol';
import { createDockerEngineSetupSteps } from './dockerEngine.js';

describe('Docker engine setup declaration', () => {
    it.each(['ubuntu', 'debian'] as const)('uses %s distro packages and Compose, grants only the daemon, and preserves Docker defaults', distribution => {
        const facts = { distribution, daemonUsername: 'happier' as const, enginePresent: false };
        const steps = createDockerEngineSetupSteps(facts);
        for (const step of steps) expect(MachineRecipeStepV1Schema.safeParse(step).success).toBe(true);
        expect(steps.find((step) => step.kind === 'package')).toMatchObject({ kind: 'package', packages: [
            { name: 'docker.io' }, { name: 'docker-buildx' }, { name: distribution === 'ubuntu' ? 'docker-compose-v2' : 'docker-compose' },
        ] });
        expect(steps.find((step) => step.kind === 'group')).toMatchObject({ name: 'docker', members: ['happier'] });
        expect(steps.findIndex((step) => step.kind === 'group')).toBeLessThan(steps.findIndex((step) => step.kind === 'serviceUnit'));
        expect(steps.some(step => step.kind === 'file')).toBe(false);
    });

    it('merges only reviewed daemon settings and validates before restarting the shared service', () => {
        const daemonConfig = { icc: false, 'no-new-privileges': true, 'log-opts': { 'max-size': '25m', 'max-file': '4' } };
        const steps = createDockerEngineSetupSteps({ distribution: 'ubuntu', daemonUsername: 'happier', enginePresent: true, daemonConfig });
        const file = steps.find(step => step.kind === 'file');
        expect(file).toMatchObject({ id: 'docker-daemon-config', kind: 'file', path: '/etc/docker/daemon.json',
            owner: 'root', group: 'root', mode: 0o644, content: { kind: 'jsonMerge', value: daemonConfig },
            validate: 'docker', onChange: { serviceStepId: 'docker-service', action: 'restart' } });
        expect(steps.some(step => step.kind === 'package')).toBe(false);
        for (const step of steps) expect(MachineRecipeStepV1Schema.safeParse(step).success).toBe(true);
    });
});
