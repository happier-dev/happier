import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/binding-compatibility';

/** Shared by the portable declaration and the native binding adapter. */
export const CLAUDE_PROVIDER_MODEL_ROLES = [
  { id: 'fast', title: 'Fast' },
  { id: 'default', title: 'Default' },
  { id: 'strongest', title: 'Strongest' },
] satisfies NonNullable<AgentProviderRequirementsV1['modelRoles']>;
