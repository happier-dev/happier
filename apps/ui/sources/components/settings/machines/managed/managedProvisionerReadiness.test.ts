import { describe, expect, it } from 'vitest';
import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { describeManagedProvisionerReadiness } from './managedProvisionerReadiness';

describe('provisioner prerequisite repair', () => {
    it('offers the missing prerequisite setup sources with their own repair Action, skipping installed requirements', () => {
        const sources = [{ kind: 'direct' as const, setup: { items: [{ kind: 'softwareRecipe' as const,
            selection: { ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: {} } }] } }];
        const action = { action: { pluginId: 'happier.devcontainer', localId: 'install-runtime' }, input: {} };
        const check = MachineProvisionerCheckResultV1Schema.parse({ available: false, prerequisites: [
            { requirement: { kind: 'systemTool', id: 'installed' }, status: 'available', repairAction: { ...action, input: { installed: true } } },
            { requirement: { kind: 'systemTool', id: 'docker' }, status: 'unavailable', setupSources: sources, repairAction: action },
        ] });
        expect(describeManagedProvisionerReadiness({ check }).repair).toEqual({ kind: 'install', action, setupSources: sources });
        expect(describeManagedProvisionerReadiness({ check: { ...check, available: true,
            prerequisites: check.prerequisites?.map(row => ({ ...row, status: 'available' })) } }).repair).toBeUndefined();
    });
});
