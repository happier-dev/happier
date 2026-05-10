import { z } from 'zod';

import {
  CLAUDE_EXTERNAL_SESSIONS_PROVIDER_ID,
  ClaudeExternalSessionsSourceSchema,
  resolveClaudeExternalSessionsSourceKey,
} from './claude/externalSessions.js';
import {
  CODEX_EXTERNAL_SESSIONS_PROVIDER_ID,
  CodexExternalSessionsSourceSchema,
  resolveCodexExternalSessionsSourceKey,
} from './codex/externalSessions.js';
import {
  OPENCODE_EXTERNAL_SESSIONS_PROVIDER_ID,
  OpenCodeExternalSessionsSourceSchema,
  resolveOpenCodeExternalSessionsSourceKey,
} from './opencode/externalSessions.js';
import {
  OH_MY_PI_EXTERNAL_SESSIONS_PROVIDER_ID,
  OhMyPiExternalSessionsSourceSchema,
  resolveOhMyPiExternalSessionsSourceKey,
} from './ohMyPi/externalSessions.js';

const EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS = [
  {
    providerId: CLAUDE_EXTERNAL_SESSIONS_PROVIDER_ID,
    sourceKind: 'claudeConfig',
    sourceSchema: ClaudeExternalSessionsSourceSchema,
    resolveSourceKey: resolveClaudeExternalSessionsSourceKey,
  },
  {
    providerId: CODEX_EXTERNAL_SESSIONS_PROVIDER_ID,
    sourceKind: 'codexHome',
    sourceSchema: CodexExternalSessionsSourceSchema,
    resolveSourceKey: resolveCodexExternalSessionsSourceKey,
  },
  {
    providerId: OPENCODE_EXTERNAL_SESSIONS_PROVIDER_ID,
    sourceKind: 'opencodeServer',
    sourceSchema: OpenCodeExternalSessionsSourceSchema,
    resolveSourceKey: resolveOpenCodeExternalSessionsSourceKey,
  },
  {
    providerId: OH_MY_PI_EXTERNAL_SESSIONS_PROVIDER_ID,
    sourceKind: 'ohMyPiAgentDir',
    sourceSchema: OhMyPiExternalSessionsSourceSchema,
    resolveSourceKey: resolveOhMyPiExternalSessionsSourceKey,
  },
] as const;

type ExternalSessionsProviderDefinition = typeof EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS[number];

const EXTERNAL_SESSIONS_SOURCE_SCHEMAS = [
  ClaudeExternalSessionsSourceSchema,
  CodexExternalSessionsSourceSchema,
  OpenCodeExternalSessionsSourceSchema,
  OhMyPiExternalSessionsSourceSchema,
] as [
  ExternalSessionsProviderDefinition['sourceSchema'],
  ...ExternalSessionsProviderDefinition['sourceSchema'][],
];

const EXTERNAL_SESSIONS_PROVIDER_DEFINITION_BY_SOURCE_KIND = Object.freeze(
  Object.fromEntries(
    EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS.map((definition) => [definition.sourceKind, definition] as const),
  ) as Record<ExternalSessionsProviderDefinition['sourceKind'], ExternalSessionsProviderDefinition>,
);

export const EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1 = Object.freeze(
  Object.fromEntries(
    EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS.map((definition) => [definition.sourceKind, [definition.providerId]] as const),
  ) as Record<ExternalSessionsProviderDefinition['sourceKind'], readonly [ExternalSessionsProviderDefinition['providerId']]>,
);

export const EXTERNAL_SESSIONS_PROVIDER_IDS = Object.freeze(
  Object.values(EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1).flat(),
) as [
  typeof EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS[number]['providerId'],
  ...(typeof EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS[number]['providerId'])[],
];

// B8 closure note:
// Direct-session provider ids/sources stay first-party constrained for this wave.
// Plugin/runtime parity should not assume plugin-defined direct-session sources yet.
export const ExternalSessionsProviderIdSchema = z.enum(EXTERNAL_SESSIONS_PROVIDER_IDS);
export type ExternalSessionsProviderId = z.infer<typeof ExternalSessionsProviderIdSchema>;
export type ExternalSessionsSourceKindV1 = keyof typeof EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1;

export const ExternalSessionsSourceSchema = z.discriminatedUnion('kind', EXTERNAL_SESSIONS_SOURCE_SCHEMAS);
export type ExternalSessionsSource = z.infer<typeof ExternalSessionsSourceSchema>;

export function resolveExternalSessionsSourceKey(source: ExternalSessionsSource): string {
  const definition = EXTERNAL_SESSIONS_PROVIDER_DEFINITION_BY_SOURCE_KIND[source.kind];
  return definition.resolveSourceKey(source as never);
}
