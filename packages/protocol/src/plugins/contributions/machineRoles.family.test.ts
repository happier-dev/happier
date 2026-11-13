import { describe, expect, it } from 'vitest';
import { PluginContributionFamilyV2Schema } from './families.js';
import { machineRoleCatalogFromPluginsV1, resolveActiveMachineRolesV1 } from '../../machines/roles/machineRolesV1.js';
import { PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 } from './v2.js';

describe('machineRoles manifest family', () => {
  it('admits plugin roles with the core role schema and resolves them through the one roles owner', () => {
    expect(PluginContributionFamilyV2Schema.options).toContain('machineRoles');
    const family = PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.find(entry => entry.family === 'machineRoles');
    expect(family).toBeDefined();
    const declaration = family!.schema.parse({ id: 'intake', title: 'Channels', description: 'Ingress', partOf: 'intake', backgroundServices: ['ingress-supervisor'] });
    const catalog = machineRoleCatalogFromPluginsV1([{ pluginId: 'happier.channels', declaration: declaration as never }]);
    expect([...resolveActiveMachineRolesV1({ host: 'x' }, catalog)]).toContain('happier.channels/intake');
    expect([...resolveActiveMachineRolesV1({ rolesV1: { active: ['sessions'] } }, catalog)]).not.toContain('happier.channels/intake');
  });
});
