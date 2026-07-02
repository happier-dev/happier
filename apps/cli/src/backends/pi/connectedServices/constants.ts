import type { CatalogAgentId } from '@/backends/types';

export const PI_CONNECTED_SERVICE_AGENT_ID = 'pi' as const satisfies CatalogAgentId;

export const PI_CONNECTED_SERVICE_REACHABILITY_ENROLLMENT_AGENT_IDS = [
  PI_CONNECTED_SERVICE_AGENT_ID,
] as const satisfies readonly CatalogAgentId[];
