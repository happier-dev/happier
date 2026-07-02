export const OPENCODE_EXTERNAL_SESSION_SOURCE = {
  providerId: 'opencode',
  sourceKind: 'opencodeServer',
  schema: {
    passthrough: true,
    fields: [
      { name: 'kind', kind: 'literal', value: 'opencodeServer' },
      { name: 'baseUrl', kind: 'unknown', optional: true },
      { name: 'directory', kind: 'unknown', optional: true },
    ],
  },
  key: {
    segments: [
      { kind: 'literal', value: 'opencodeServer' },
      { kind: 'field', field: 'baseUrl' },
      { kind: 'field', field: 'directory' },
    ],
  },
} as const;
