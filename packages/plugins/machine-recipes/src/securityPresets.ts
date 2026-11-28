import type { MachineSetupPresetContributionV1 } from '@happier-dev/plugin-sdk';

type SecurityPreset = Omit<MachineSetupPresetContributionV1, 'id'>;

/** Inputs belong to each recipe's review; bundles only select pinned recipes in order. */
function recipeSetup(recipeIds: readonly string[]): SecurityPreset['setup'] {
  return { items: recipeIds.map(recipeId => ({ kind: 'setupRecipe' as const, selection: {
    ref: { pluginId: 'happier.machine.recipes', recipeId, revision: '1' }, inputs: {},
  } })) };
}

export const securityPresets: Readonly<Record<string, SecurityPreset>> = {
  'secure-web-host-v1': {
    revision: '1', title: 'Secure web host',
    description: 'Security updates, SSH hardening, bounded logs, Docker, Caddy and a firewall. Review the setup options before applying.',
    setup: recipeSetup([
      'automatic-security-updates', 'ssh-hardening', 'ssh-fail2ban', 'audit-logging',
      'bounded-journal', 'docker-engine', 'caddy', 'firewall',
    ]),
  },
  'private-box-v1': {
    revision: '1', title: 'Private box',
    description: 'Security updates, SSH hardening, bounded logs, Tailscale and a firewall. Review the setup options and choose a saved Tailscale key before applying.',
    setup: recipeSetup(['automatic-security-updates', 'ssh-hardening', 'bounded-journal', 'tailscale-server', 'firewall']),
  },
};
