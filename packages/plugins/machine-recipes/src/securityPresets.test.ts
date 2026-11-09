import { expect, it } from 'vitest';
import { MachineSetupPresetContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineSetupPresets';
import { securityPresets } from './securityPresets.js';

it('offers ordered setup-only security presets without choosing required machine-specific inputs or an app', () => {
  const expected = {
    'secure-web-host-v1': ['automatic-security-updates', 'ssh-hardening', 'ssh-fail2ban', 'audit-logging', 'bounded-journal', 'docker-engine', 'caddy', 'firewall'],
    'private-box-v1': ['automatic-security-updates', 'ssh-hardening', 'bounded-journal', 'tailscale-server', 'firewall'],
    'production-web-server-v1': ['automatic-security-updates', 'ssh-hardening', 'ssh-fail2ban', 'audit-logging', 'bounded-journal', 'docker-engine', 'caddy', 'firewall'],
  };
  expect(Object.keys(securityPresets)).toEqual(Object.keys(expected));
  for (const [id, recipeIds] of Object.entries(expected)) {
    const preset = MachineSetupPresetContributionV1Schema.parse({ id, ...securityPresets[id] });
    expect(preset.setup.items?.map(item => item.kind === 'app' ? 'app' : item.selection.ref.recipeId)).toEqual(recipeIds);
    expect(preset.setup.items).toEqual(recipeIds.map(recipeId => ({ kind: 'setupRecipe', selection: {
      ref: { pluginId: 'happier.machine.recipes', recipeId, revision: '1' }, inputs: {},
    } })));
  }
  expect(securityPresets['production-web-server-v1']?.setup).toEqual(securityPresets['secure-web-host-v1']?.setup);
});
