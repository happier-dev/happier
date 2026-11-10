import { createCaddyContainerSetupDeclarations, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';

/** P20 prepares owned state only; P41 supplies and runs the reviewed container topology. */
export const caddy: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Caddy', software: true, icon: 'desktop',
  description: 'Serves your apps over HTTPS.',
  inputSchema: { type: 'object', properties: {
    initialConfig: { type: 'string', minLength: 1 },
  }, required: ['initialConfig'], additionalProperties: false },
  inputHints: { fields: [{ path: 'initialConfig', title: 'Reviewed Caddy configuration', widget: 'textarea', required: true }] },
  steps: createCaddyContainerSetupDeclarations({ daemonGroup: { kind: 'targetFact', fact: 'daemon.primaryGroup' },
    initialConfig: { kind: 'input', path: 'initialConfig' } }).map(step => ({ ...step,
      requiredFacts: [{ kind: 'init', system: 'systemd' }],
    })),
};
