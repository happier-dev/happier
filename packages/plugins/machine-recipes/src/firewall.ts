import { getMachineFirewallOpenPortsInputSchemaV1, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';

/** A person opens ports; the one firewall renderer lowers them to the owned table the native owner stages and restores. */
export const firewall: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Firewall', software: true, icon: 'shield',
  description: 'Blocks everything you didn’t open, and keeps your access to this machine.',
  inputSchema: { type: 'object', properties: { open: getMachineFirewallOpenPortsInputSchemaV1() },
    required: ['open'], additionalProperties: false },
  inputHints: { fields: [
    { path: 'open.tcp', title: 'TCP ports', widget: 'text_list', listSeparator: 'comma', required: true,
      description: 'For example 22 for SSH, 80 and 443 for a website. Leave out 22 only if you reach this machine another way.' },
    { path: 'open.udp', title: 'UDP ports', widget: 'text_list', listSeparator: 'comma',
      description: 'Only if a service needs them, such as 51820 for WireGuard.' },
    { path: 'open.from', title: 'Allow from', widget: 'text_list', listSeparator: 'comma',
      description: 'Addresses or ranges such as 203.0.113.4/32. Leave empty to allow anyone.' },
  ] },
  steps: [{ id: 'owned-firewall', kind: 'firewall', requiredFacts: [{ kind: 'init', system: 'systemd' }],
    rules: { kind: 'openPorts', path: 'open' } }],
  removeSteps: [{ id: 'owned-firewall', kind: 'firewall', operation: 'remove',
    requiredFacts: [{ kind: 'init', system: 'systemd' }], rules: { kind: 'openPorts', path: 'open' } }],
};
