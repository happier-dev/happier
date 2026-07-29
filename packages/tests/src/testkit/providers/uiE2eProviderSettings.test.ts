import {
  ProviderContributionV1Schema,
  canonicalizeProviderContributionKeyV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { ResolvedProviderContribution } from '../../../../../apps/cli/src/plugins/projection/registry/types';
import { resolveProviderConnectionForMachine } from '../../../../../apps/cli/src/providers/registry/resolve';
import { LMSTUDIO_PROVIDER_CONTRIBUTION } from '../../../../plugins/lmstudio/src/provider/contribution';
import {
  buildLmStudioProviderUiE2eSettings,
  LMSTUDIO_PROVIDER_CONTRIBUTION_KEY,
  lmStudioProviderUiE2eBaseUrl,
} from './uiE2eProviderSettings';
import { startProviderUiE2eEndpoint } from './uiE2eProviderEndpoint';

describe('Provider UI E2E settings fixture', () => {
  it('serves the selected model through owned LM Studio and OpenAI catalog endpoints', async () => {
    const endpoint = await startProviderUiE2eEndpoint();
    try {
      const nativeResponse = await fetch(`${endpoint.baseUrl}/api/v1/models`);
      const openAiResponse = await fetch(`${endpoint.baseUrl}/v1/models`);

      expect(nativeResponse.status).toBe(200);
      expect(await nativeResponse.json()).toEqual({
        models: [{
          key: 'provider-e2e-model',
          display_name: 'Provider E2E Model',
          type: 'llm',
          loaded_instances: [{ id: 'provider-e2e-loaded-instance' }],
        }],
      });
      expect(openAiResponse.status).toBe(200);
      expect(await openAiResponse.json()).toEqual({
        object: 'list',
        data: [{ id: 'provider-e2e-model', name: 'Provider E2E Model' }],
      });

      const settings = buildLmStudioProviderUiE2eSettings({
        machineId: 'machine-provider-ui-e2e',
        connectionBaseUrls: [endpoint.baseUrl],
      });
      expect(settings.connections[0]?.endpointOverridesByMachineId?.['machine-provider-ui-e2e']).toEqual([
        { endpointTemplateId: 'lmstudio-openai-responses', baseUrl: `${endpoint.baseUrl}/v1` },
        { endpointTemplateId: 'lmstudio-openai-chat', baseUrl: `${endpoint.baseUrl}/v1` },
        { endpointTemplateId: 'lmstudio-anthropic', baseUrl: new URL(endpoint.baseUrl).toString() },
      ]);
    } finally {
      await endpoint.stop();
    }
  });

  it('resolves every LM Studio endpoint through the canonical CLI resolver', () => {
    const machineId = 'machine-provider-ui-e2e';
    const origin = lmStudioProviderUiE2eBaseUrl();
    const normalizedOrigin = new URL(origin).toString();
    const contribution = {
      provenance: 'first_party',
      source: { kind: 'bundled' },
      pluginId: 'happier.provider.lmstudio',
      identity: { pluginId: 'happier.provider.lmstudio', localId: 'lmstudio' },
      definition: ProviderContributionV1Schema.parse(LMSTUDIO_PROVIDER_CONTRIBUTION),
    } satisfies ResolvedProviderContribution;

    const result = resolveProviderConnectionForMachine({
      connectionId: 'pc_e2e_lmstudio_1',
      machineId,
      accountSettings: {
        providerSettingsV1: buildLmStudioProviderUiE2eSettings({ machineId }),
      },
      registry: {
        providersByContributionKey: new Map([
          [canonicalizeProviderContributionKeyV1(LMSTUDIO_PROVIDER_CONTRIBUTION_KEY), contribution],
        ]),
      },
      dnsEvidenceByEndpointUrl: new Map([
        [origin, ['127.0.0.1']],
        [`${origin}/v1`, ['127.0.0.1']],
      ]),
    });

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error(`Expected resolved fixture, received ${result.status}`);
    expect(Object.fromEntries(result.record.endpoints.map((endpoint) => [
      endpoint.endpointTemplateId,
      endpoint.normalizedUrl,
    ]))).toEqual({
      'lmstudio-openai-responses': `${origin}/v1`,
      'lmstudio-openai-chat': `${origin}/v1`,
      'lmstudio-anthropic': normalizedOrigin,
    });
  });
});
