// Agent37 create, sizing and billing references, observed 2026-11-05.
// One table owns the shipped types, templates, compute rates and region admission.
// The current container system image publishes OCI Config.User=node.
const containerTemplate = { template: 'agent37-base', preparationBaseUser: 'node' } as const;

export const KINDS = [
  { id: 'vm', title: 'VM: Ubuntu desktop', template: 'agent37-ubuntu', preparationBaseUser: null, computeMultiplier: 2.5,
    regions: ['us', 'eu', 'ap-south'],
    description: 'Coding, terminals and GUI through the Happier virtual-display recipe. Persistent disk; cold boot on start; automatic sleep off.' },
  { id: 'default', title: 'Container', ...containerTemplate, computeMultiplier: 1,
    regions: ['us'],
    description: 'Coding and terminals only. Lower compute rate. Persistent disk; cold boot on start; automatic sleep off.' },
  { id: 'performance', title: 'Performance', ...containerTemplate, computeMultiplier: 4,
    regions: ['us', 'eu', 'ap-south'],
    description: 'Dedicated compute for coding and computer use, at four times container compute. GUI uses the Happier virtual-display recipe. Persistent disk; cold boot on start; automatic sleep off.' },
] as const;
