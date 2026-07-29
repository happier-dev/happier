import {
  ProviderConnectionV1Schema,
  ProviderSettingsV1Schema,
  deleteProviderConnectionV1,
  ensureDefaultProviderConnectionV1,
  type CustomProviderTemplateV1,
  type ProviderConnectionV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

export function addProviderContributionConnection(input: Readonly<{
  settings: ProviderSettingsV1;
  contributionKey: string;
  contributionName: string;
  connectionId: string;
  displayName: string | null;
  now: number;
}>): Readonly<{ settings: ProviderSettingsV1; connection: ProviderConnectionV1; created: boolean }> {
  if (input.displayName === null) {
    const result = ensureDefaultProviderConnectionV1(input.settings, {
      contributionKey: input.contributionKey,
      allocatedConnectionId: input.connectionId,
      providerName: input.contributionName,
      now: input.now,
    });
    return { settings: result.settings, connection: result.connection, created: result.changed };
  }
  const connection = ProviderConnectionV1Schema.parse({
    v: 1,
    id: input.connectionId,
    source: { kind: 'contribution', contributionKey: input.contributionKey },
    role: 'named',
    displayName: input.displayName,
    displayNameMode: 'custom',
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return {
    settings: ProviderSettingsV1Schema.parse({
      ...input.settings,
      connections: [...input.settings.connections, connection],
    }),
    connection,
    created: true,
  };
}

export function addCustomProviderConnection(input: Readonly<{
  settings: ProviderSettingsV1;
  connectionId: string;
  template: CustomProviderTemplateV1;
  now: number;
}>): Readonly<{ settings: ProviderSettingsV1; connection: ProviderConnectionV1 }> {
  const connection = ProviderConnectionV1Schema.parse({
    v: 1,
    id: input.connectionId,
    source: { kind: 'custom', template: input.template },
    role: 'named',
    displayName: input.template.name,
    displayNameMode: 'custom',
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return {
    settings: ProviderSettingsV1Schema.parse({
      ...input.settings,
      connections: [...input.settings.connections, connection],
    }),
    connection,
  };
}

export { deleteProviderConnectionV1 };
