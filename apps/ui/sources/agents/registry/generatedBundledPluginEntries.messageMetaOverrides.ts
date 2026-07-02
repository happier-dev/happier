/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * This file is the UI-side generated bundled entry map for first-party bundled
 * provider message metadata override builders.
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

import type { AgentId } from '@/agents/catalog/catalog';

export type ProviderMessageMetaOverrideDescriptor = Readonly<{
    agentId: AgentId;
    descriptor: Readonly<Record<string, unknown>>;
}>;

export type ProviderMessageMetaOverrideBuilder = (params: Readonly<{
    session: unknown;
    metaOverrides?: Record<string, unknown>;
}>) => Record<string, unknown> | undefined;

export const BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_DESCRIPTORS: Readonly<
    Partial<Record<AgentId, ProviderMessageMetaOverrideDescriptor>>
> = Object.freeze({
    claude: Object.freeze({
        agentId: 'claude' as AgentId,
        descriptor: Object.freeze({
  "metaOverrides": [
    {
      "id": "reasoning-effort",
      "normalize": "trimLowercase",
      "targetKey": "reasoningEffort",
      "value": {
        "key": "reasoning_effort",
        "kind": "sessionConfigOptionOverride"
      }
    }
  ]
} as const),
    }),
});

export const BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS: Readonly<
    Partial<Record<AgentId, ProviderMessageMetaOverrideBuilder>>
> = Object.freeze({});
