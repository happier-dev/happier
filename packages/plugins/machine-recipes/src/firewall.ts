import { getMachineFirewallExposureInputSchemaV1, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';

/** P21 supplies the reviewed candidate; the native owner validates, stages and restores it. */
export const firewall: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Firewall', software: true, icon: 'shield',
  description: 'Apply the reviewed Happier-owned nftables policy while preserving foreign rules and management access.',
  inputSchema: { type: 'object', properties: {
    rules: { type: 'string', minLength: 1 },
    exposures: { type: 'array', items: getMachineFirewallExposureInputSchemaV1() },
  }, required: ['rules', 'exposures'], additionalProperties: false },
  inputHints: { fields: [
    { path: 'rules', title: 'Reviewed nftables candidate', widget: 'textarea', required: true },
    { path: 'exposures', title: 'Reviewed network exposures', widget: 'json', required: true },
  ] },
  steps: [{ id: 'owned-firewall', kind: 'firewall', requiredFacts: [{ kind: 'init', system: 'systemd' }],
    rules: { kind: 'input', path: 'rules' }, exposures: { kind: 'input', path: 'exposures' } }],
};
