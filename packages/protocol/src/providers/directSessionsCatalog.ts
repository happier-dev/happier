import { z } from 'zod';

import {
  CLAUDE_DIRECT_SESSIONS_PROVIDER_ID,
  ClaudeDirectSessionsSourceSchema,
  resolveClaudeDirectSessionsSourceKey,
} from './claude/directSessions.js';
import {
  CODEX_DIRECT_SESSIONS_PROVIDER_ID,
  CodexDirectSessionsSourceSchema,
  resolveCodexDirectSessionsSourceKey,
} from './codex/directSessions.js';
import {
  OPENCODE_DIRECT_SESSIONS_PROVIDER_ID,
  OpenCodeDirectSessionsSourceSchema,
  resolveOpenCodeDirectSessionsSourceKey,
} from './opencode/directSessions.js';
import {
  OH_MY_PI_DIRECT_SESSIONS_PROVIDER_ID,
  OhMyPiDirectSessionsSourceSchema,
  resolveOhMyPiDirectSessionsSourceKey,
} from './ohMyPi/directSessions.js';

const DIRECT_SESSIONS_PROVIDER_DEFINITIONS = [
  {
    providerId: CLAUDE_DIRECT_SESSIONS_PROVIDER_ID,
    sourceKind: 'claudeConfig',
    sourceSchema: ClaudeDirectSessionsSourceSchema,
    resolveSourceKey: resolveClaudeDirectSessionsSourceKey,
  },
  {
    providerId: CODEX_DIRECT_SESSIONS_PROVIDER_ID,
    sourceKind: 'codexHome',
    sourceSchema: CodexDirectSessionsSourceSchema,
    resolveSourceKey: resolveCodexDirectSessionsSourceKey,
  },
  {
    providerId: OPENCODE_DIRECT_SESSIONS_PROVIDER_ID,
    sourceKind: 'opencodeServer',
    sourceSchema: OpenCodeDirectSessionsSourceSchema,
    resolveSourceKey: resolveOpenCodeDirectSessionsSourceKey,
  },
  {
    providerId: OH_MY_PI_DIRECT_SESSIONS_PROVIDER_ID,
    sourceKind: 'ohMyPiAgentDir',
    sourceSchema: OhMyPiDirectSessionsSourceSchema,
    resolveSourceKey: resolveOhMyPiDirectSessionsSourceKey,
  },
] as const;

type DirectSessionsProviderDefinition = typeof DIRECT_SESSIONS_PROVIDER_DEFINITIONS[number];

const DIRECT_SESSIONS_SOURCE_SCHEMAS = [
  ClaudeDirectSessionsSourceSchema,
  CodexDirectSessionsSourceSchema,
  OpenCodeDirectSessionsSourceSchema,
  OhMyPiDirectSessionsSourceSchema,
] as [
  DirectSessionsProviderDefinition['sourceSchema'],
  ...DirectSessionsProviderDefinition['sourceSchema'][],
];

const DIRECT_SESSIONS_PROVIDER_DEFINITION_BY_SOURCE_KIND = Object.freeze(
  Object.fromEntries(
    DIRECT_SESSIONS_PROVIDER_DEFINITIONS.map((definition) => [definition.sourceKind, definition] as const),
  ) as Record<DirectSessionsProviderDefinition['sourceKind'], DirectSessionsProviderDefinition>,
);

export const DIRECT_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1 = Object.freeze(
  Object.fromEntries(
    DIRECT_SESSIONS_PROVIDER_DEFINITIONS.map((definition) => [definition.sourceKind, [definition.providerId]] as const),
  ) as Record<DirectSessionsProviderDefinition['sourceKind'], readonly [DirectSessionsProviderDefinition['providerId']]>,
);

export const DIRECT_SESSIONS_PROVIDER_IDS = Object.freeze(
  Object.values(DIRECT_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1).flat(),
) as [
  typeof DIRECT_SESSIONS_PROVIDER_DEFINITIONS[number]['providerId'],
  ...(typeof DIRECT_SESSIONS_PROVIDER_DEFINITIONS[number]['providerId'])[],
];

// B8 closure note:
// Direct-session provider ids/sources stay first-party constrained for this wave.
// Plugin/runtime parity should not assume plugin-defined direct-session sources yet.
export const DirectSessionsProviderIdSchema = z.enum(DIRECT_SESSIONS_PROVIDER_IDS);
export type DirectSessionsProviderId = z.infer<typeof DirectSessionsProviderIdSchema>;
export type DirectSessionsSourceKindV1 = keyof typeof DIRECT_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1;

export const DirectSessionsSourceSchema = z.discriminatedUnion('kind', DIRECT_SESSIONS_SOURCE_SCHEMAS);
export type DirectSessionsSource = z.infer<typeof DirectSessionsSourceSchema>;

export function resolveDirectSessionsSourceKey(source: DirectSessionsSource): string {
  const definition = DIRECT_SESSIONS_PROVIDER_DEFINITION_BY_SOURCE_KIND[source.kind];
  return definition.resolveSourceKey(source as never);
}
