import { expect, it } from 'vitest';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../plugins/deepseek/src/provider/contribution.js';
import { ProviderContributionV1Schema } from '../contributions/v1.js';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '../settings/v1.js';
import { prepareProviderConnectionCreationV1 } from './creationV1.js';

it.each([undefined, 'machine-a'])('refuses an undeclared configured endpoint before persistence (%s)', machineId => {
  const definition = ProviderContributionV1Schema.parse(DEEPSEEK_PROVIDER_CONTRIBUTION);
  expect(() => prepareProviderConnectionCreationV1({ settings: DEFAULT_PROVIDER_SETTINGS_V1,
    connectionId: 'pc_invalid', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek',
      definition, displayName: 'Invalid' }, savedSecretId: null,
    endpointOverrides: { values: [{ endpointTemplateId: 'undeclared', baseUrl: 'https://changed.invalid/v1' }],
      ...(machineId ? { machineId } : {}) }, now: 10,
  })).toThrowError(expect.objectContaining({ code: 'provider_connection_invalid' }));
});

it('preserves a reused default exactly despite unused invalid creation operands', () => {
  const source = { kind: 'contribution' as const, contributionKey: 'happier.provider.deepseek/deepseek',
    definition: ProviderContributionV1Schema.parse(DEEPSEEK_PROVIDER_CONTRIBUTION), displayName: null };
  const first = prepareProviderConnectionCreationV1({ settings: DEFAULT_PROVIDER_SETTINGS_V1,
    connectionId: 'pc_default', source, savedSecretId: null, now: 10 });
  const reused = prepareProviderConnectionCreationV1({ settings: first.settings,
    connectionId: 'pc_unused', source, savedSecretId: 'unused-secret', manualModels: [{ id: 'unused-model' }],
    endpointOverrides: { values: [{ endpointTemplateId: 'undeclared', baseUrl: 'https://changed.invalid/v1' }] }, now: 20 });
  expect(reused).toEqual({ settings: first.settings, connection: first.connection, created: false });
});
