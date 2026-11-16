import { describe, expect, it } from 'vitest';

const { compileDeploymentEnvironmentListFilterV1, DEFAULT_DEPLOYMENT_ENVIRONMENT_LIST_FILTER_V1 } =
    await import('./deploymentEnvironmentListFilterV1.js');

const facts = (projectSourceId: string, state: 'needsYou' | 'deploying' | 'deployed' | 'notDeployed', machineId: string | null) =>
    ({ projectSourceId, state, machineId });

describe('Services (deploymentEnvironment) list filter', () => {
    it('matches every Environment with no narrowing', () => {
        const match = compileDeploymentEnvironmentListFilterV1(DEFAULT_DEPLOYMENT_ENVIRONMENT_LIST_FILTER_V1);
        expect(match(facts('p1', 'deployed', 'm1'))).toBe('match');
    });

    it('narrows by Project, state and Machine, include and exclude, all at once', () => {
        const match = compileDeploymentEnvironmentListFilterV1({
            projects: { include: ['p1'], exclude: [] },
            states: { include: ['needsYou', 'deploying'], exclude: [] },
            machines: { include: [], exclude: ['m2'] },
        });
        expect(match(facts('p1', 'needsYou', 'm1'))).toBe('match');
        expect(match(facts('p2', 'needsYou', 'm1'))).toBe('miss');
        expect(match(facts('p1', 'deployed', 'm1'))).toBe('miss');
        expect(match(facts('p1', 'deploying', 'm2'))).toBe('miss');
    });
});
