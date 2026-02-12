import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';

export const cliCapability: Capability = {
  descriptor: { id: 'cli.pi', kind: 'cli', title: 'Pi CLI' },
  detect: async ({ request, context }) => {
    const entry = context.cliSnapshot?.clis?.pi;
    return buildCliCapabilityData({ request, entry });
  },
};
