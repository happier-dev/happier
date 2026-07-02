export const CLAUDE_EXTERNAL_SESSION_SOURCE = {
  providerId: 'claude',
  sourceKind: 'claudeConfig',
  schema: {
    passthrough: true,
    fields: [
      { name: 'kind', kind: 'literal', value: 'claudeConfig' },
      { name: 'configDir', kind: 'string', min: 1, max: 10_000, nullish: true },
      { name: 'projectId', kind: 'string', min: 1, max: 2_000, nullish: true },
    ],
  },
  key: {
    segments: [
      { kind: 'literal', value: 'claudeConfig' },
      { kind: 'field', field: 'configDir' },
      { kind: 'field', field: 'projectId' },
    ],
  },
} as const;
