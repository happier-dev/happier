import { PLUGIN_MANIFEST as GROK_MANIFEST } from '@happier-dev/plugins-grok/manifest';
import { PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import { chooseProviderGatewayContributionV1, readProviderGatewayFamilyAvailabilityV1 } from '@happier-dev/protocol/providers/gatewayContributionsV1';

import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from './contribution.js';

describe('managed families awaiting the SDK registration seam', () => {
  const contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
  const declarations = [{
    contributionKey,
    definition: ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION),
    provenance: 'external' as const,
  }];

  it('declares unavailable account families for presentation without adding executable purposes', () => {
    const localizedText = expect.objectContaining({
      key: expect.any(String), fallback: expect.any(String),
    });
    const unavailableFamilies = [
      { purpose: 'antigravity-upstream', service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }, title: localizedText, unavailableReason: localizedText },
      { purpose: 'kimi-upstream', service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, title: localizedText, unavailableReason: localizedText },
      { purpose: 'xai-upstream', service: { pluginId: 'happier.agent.grok', localId: 'xai' }, title: localizedText, unavailableReason: localizedText },
      { purpose: 'devin-upstream', service: { pluginId: 'happier.agent.devin', localId: 'devin-account' }, title: localizedText, unavailableReason: localizedText },
    ];
    expect(declarations[0]!.definition).toHaveProperty('managedRuntime.unavailableConnectedAccounts', unavailableFamilies);
    const presentation = readProviderGatewayFamilyAvailabilityV1(contributionKey, declarations)!;
    expect(presentation.filter((family) => family.status === 'unavailable')).toEqual(
      unavailableFamilies.map((family) => ({ ...family, status: 'unavailable' })),
    );
    expect(presentation.filter((family) => family.status === 'available').map((family) => family.purpose).sort())
      .toEqual(['anthropic-upstream', 'gemini-upstream', 'meta-upstream', 'openai-upstream']);
    const xaiFamily = presentation.find(family => family.purpose === 'xai-upstream')!;
    expect(xaiFamily.service.pluginId).toBe(GROK_MANIFEST.id);
    expect(GROK_MANIFEST.contributes.connectedAccountDescriptors.some(service => service.id === xaiFamily.service.localId)).toBe(true);
    expect(GROK_MANIFEST.contributes.agents[0]!.connectedAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: xaiFamily.service.localId }),
    ]));
    expect(declarations[0]!.definition.managedRuntime!.connectedAccounts).toHaveLength(4);
    expect(declarations[0]!.definition.managedRuntime!.requestAuthUses).toHaveLength(4);
  });

  it.each([
    ['antigravity-upstream', { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }],
    ['kimi-upstream', { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }],
    ['xai-upstream', { pluginId: 'happier.agent.grok', localId: 'xai' }],
    ['devin-upstream', { pluginId: 'happier.agent.devin', localId: 'devin-account' }],
  ] as const)('returns typed unavailable for %s without selecting another family', (purpose, service) => {
    for (const input of [{ purpose }, { service }, { contributionKey, purpose, service }]) {
      const result = chooseProviderGatewayContributionV1(declarations, input);
      expect(PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.gateways.choose'].parse(result)).toEqual({
        status: 'unavailable', choices: [],
        unavailableFamilies: [{ contributionKey, ...declarations[0]!.definition.managedRuntime!.unavailableConnectedAccounts!.find(row => row.purpose === purpose)! }],
      });
    }
  });

  it('keeps an executable account family selectable through the same chooser', () => {
    expect(chooseProviderGatewayContributionV1(declarations, {
      contributionKey,
      purpose: 'openai-upstream',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
    })).toMatchObject({ status: 'selected', contribution: { contributionKey } });
  });
});
