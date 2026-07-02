export const CODEX_EXTERNAL_SESSION_SOURCE = {
  providerId: 'codex',
  sourceKind: 'codexHome',
  schema: {
    passthrough: true,
    fields: [
      { name: 'kind', kind: 'literal', value: 'codexHome' },
      { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
      { name: 'homePath', kind: 'string', min: 1, optional: true },
      { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
      { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
      { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
    ],
    refinements: [
      { kind: 'requiresWhenEquals', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
      {
        kind: 'forbidsWhenEquals',
        fields: ['connectedServiceId', 'connectedServiceProfileId', 'connectedServiceGroupId'],
        when: { field: 'home', equals: 'user' },
      },
    ],
  },
  key: {
    segments: [
      { kind: 'literal', value: 'codexHome' },
      { kind: 'homeMode', field: 'home' },
      { kind: 'conditionalField', field: 'connectedServiceId', when: { field: 'home', equals: 'connectedService' } },
      {
        kind: 'connectedServiceScope',
        groupField: 'connectedServiceGroupId',
        profileField: 'connectedServiceProfileId',
        when: { field: 'home', equals: 'connectedService' },
      },
      { kind: 'field', field: 'homePath' },
    ],
  },
} as const;
