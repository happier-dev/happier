import { describe, expect, it } from 'vitest';
import { MachineRecipeStepV1Schema } from '@happier-dev/protocol';
import { createDockerEngineSetupSteps } from './dockerEngine.js';

describe('Docker engine setup declaration', () => {
    it('uses the signed native package source and Compose, grants only the daemon, and preserves Docker defaults', () => {
        const steps = createDockerEngineSetupSteps({ distribution: 'ubuntu', codename: 'noble', architecture: 'arm64', daemonUsername: 'happier' });
        for (const step of steps) expect(MachineRecipeStepV1Schema.safeParse(step).success).toBe(true);
        expect(steps.find((step) => step.kind === 'packageSource')).toMatchObject({ url: 'https://download.docker.com/linux/ubuntu', suite: 'noble', architectures: ['arm64'], components: ['stable'], keyFingerprint: '9DC858229FC7DD38854AE2D88D81803C0EBFCD88' });
        expect(steps.find((step) => step.id === 'docker-packages')).toMatchObject({ kind: 'package', packages: expect.arrayContaining([{ name: 'docker-ce' }, { name: 'docker-compose-plugin' }]) });
        expect(steps.find((step) => step.kind === 'group')).toMatchObject({ name: 'docker', members: ['happier'] });
        expect(steps.filter((step) => step.kind === 'file')).toEqual([]);
        expect(steps.findIndex((step) => step.kind === 'group')).toBeLessThan(steps.findIndex((step) => step.kind === 'serviceUnit'));
    });
});
