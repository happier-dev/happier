export const OH_MY_PI_EXTERNAL_SESSION_SOURCE = {
  providerId: 'ohMyPi',
  sourceKind: 'ohMyPiAgentDir',
  schema: {
    passthrough: true,
    fields: [
      { name: 'kind', kind: 'literal', value: 'ohMyPiAgentDir' },
      { name: 'agentDir', kind: 'string', min: 1, max: 10_000, nullish: true },
    ],
  },
  key: {
    segments: [
      { kind: 'literal', value: 'ohMyPiAgentDir' },
      { kind: 'field', field: 'agentDir' },
    ],
  },
} as const;
