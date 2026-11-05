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
    });
});
