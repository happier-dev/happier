import { describe, expect, it } from 'vitest';

import { reduceUiDeploymentFreshness } from './uiDeploymentFreshness';

describe('reduceUiDeploymentFreshness', () => {
    it('warns only after observing two different valid deployment identifiers', () => {
        const empty = { baselineId: null, updateAvailable: false } as const;
        expect(reduceUiDeploymentFreshness(empty, null)).toEqual(empty);

        const baseline = reduceUiDeploymentFreshness(empty, 'deployment_A_123456');
        expect(baseline).toEqual({ baselineId: 'deployment_A_123456', updateAvailable: false });
        expect(reduceUiDeploymentFreshness(baseline, null)).toEqual(baseline);
        expect(reduceUiDeploymentFreshness(baseline, 'malformed version=1')).toEqual(baseline);
        expect(reduceUiDeploymentFreshness(baseline, 'deployment_A_123456')).toEqual(baseline);
        expect(reduceUiDeploymentFreshness(baseline, 'deployment_B_123456')).toEqual({
            baselineId: 'deployment_A_123456',
            updateAvailable: true,
        });
    });
});
