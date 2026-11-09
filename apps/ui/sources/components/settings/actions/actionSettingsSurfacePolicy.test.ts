import { describe, expect, it } from 'vitest';

import { listActionSpecs} from '@happier-dev/protocol/actions/actionSpecs';
import { listActionSurfacePolicies } from '@happier-dev/protocol/actions/actionSurfaceAvailability';

import { listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';

describe('action settings surface policy', () => {
    it('only exposes settings targets for surfaces classified as settings-configurable', () => {
        const policies = listActionSurfacePolicies();
        type PolicySurface = (typeof policies)[number]['surface'];
        const policySurfaces = new Set<PolicySurface>(policies.map((policy) => policy.surface));
        const isPolicySurface = (surface: string): surface is PolicySurface => policySurfaces.has(surface as PolicySurface);
        const visibleSurfaceTargets = new Set<PolicySurface>(
            listActionSpecs()
                .flatMap((spec) => listActionSettingsTargetDefinitions(spec))
                .flatMap((target) => (
                    target.kind === 'surface' && isPolicySurface(target.surface) ? [target.surface] : []
                )),
        );

        for (const policy of policies) {
            if (policy.settingsConfigurable) {
                expect(visibleSurfaceTargets.has(policy.surface)).toBe(true);
            } else {
                expect(visibleSurfaceTargets.has(policy.surface)).toBe(false);
            }
        }
    });
});
