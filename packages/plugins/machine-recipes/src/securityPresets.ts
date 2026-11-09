import type { MachineSetupPresetContributionV1 } from '@happier-dev/plugin-sdk';

type SecurityPreset = Omit<MachineSetupPresetContributionV1, 'id'>;

/** Inputs belong to each recipe's review; bundles only select pinned recipes in order. */
function recipeSetup(recipeIds: readonly string[]): SecurityPreset['setup'] {
  return { items: recipeIds.map(recipeId => ({ kind: 'setupRecipe' as const, selection: {
    ref: { pluginId: 'happier.machine.recipes', recipeId, revision: '1' }, inputs: {},
  } })) };
}

const secureWebHostSetup = recipeSetup([
  'automatic-security-updates', 'ssh-hardening', 'ssh-fail2ban', 'audit-logging',
  'bounded-journal', 'docker-engine', 'caddy', 'firewall',
]);

export const securityPresets: Readonly<Record<string, SecurityPreset>> = {
  'secure-web-host-v1': {
    revision: '1', title: 'Secure web host',
    description: 'Security updates, SSH hardening, bounded logs, Docker, Caddy and a firewall. Review the setup options before applying.',
    setup: secureWebHostSetup,
  },
  'private-box-v1': {
    revision: '1', title: 'Private box',
    description: 'Security updates, SSH hardening, bounded logs, Tailscale and a firewall. Review the setup options and choose a saved Tailscale key before applying.',
    setup: recipeSetup(['automatic-security-updates', 'ssh-hardening', 'bounded-journal', 'tailscale-server', 'firewall']),
  },
  'production-web-server-v1': {
    revision: '1', title: 'Production web server',
    description: 'The Secure web host setup for running web applications. Choose and deploy applications separately.',
    setup: secureWebHostSetup,
  },
};
