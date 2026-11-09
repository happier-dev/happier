import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from './contribution.js';

describe('CLIPROXYAPI_PROVIDER_CONTRIBUTION', () => {
  it('publishes credential-free SDK compatibility models for each managed service without claiming tool support', () => {
    const parsed = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);
    const families = parsed.managedRuntime?.connectedAccounts ?? [];
    expect(families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        purpose: 'openai-upstream',
        staticModels: expect.arrayContaining([expect.objectContaining({ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' })]),
      }),
      expect.objectContaining({
        purpose: 'anthropic-upstream',
        staticModels: expect.arrayContaining([expect.objectContaining({ id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5' })]),
      }),
    ]));
    expect(families.find((family) => family.purpose === 'openai-upstream')?.staticModels)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'claude-sonnet-4-6' })]));
    expect(families.find((family) => family.purpose === 'anthropic-upstream')?.staticModels)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'gpt-6.1-sol' })]));
    const codexModels = families.find((family) => family.purpose === 'openai-upstream')?.staticModels ?? [];
    for (const retiredId of ['gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']) {
      expect(codexModels.some((model) => model.id === retiredId)).toBe(false);
    }
    const imageModelIds = [
      'gpt-image-1.5', 'gpt-image-2',
      'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
      'gpt-image-2.6', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst',
    ];
    expect(codexModels.filter((model) => model.capabilities?.toolRoundTrips === 'unsupported')
      .map((model) => model.id).sort()).toEqual(imageModelIds);
    for (const family of families) {
      expect(new Set(family.staticModels?.map((model) => model.id)).size).toBe(family.staticModels?.length);
      for (const model of family.staticModels ?? []) {
        expect(model.capabilities).toEqual({
          toolRoundTrips: imageModelIds.includes(model.id) ? 'unsupported' : 'unknown',
          reasoningControls: 'unknown',
        });
        expect(model).not.toHaveProperty('accountEntitlementVerified');
      }
    }
    expect(parsed.catalog.source).toBe('probe');
  });

  it('publishes exact pinned-SDK effort choices without borrowing levels for budget-only or image models', () => {
    // Parsing the real contribution exercises the strict descriptor consumer,
    // not a reconstructed copy of its model-option shape.
    const families = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION)
      .managedRuntime?.connectedAccounts ?? [];
    const codexModels = families.find((family) => family.purpose === 'openai-upstream')?.staticModels ?? [];
    const claudeModels = families.find((family) => family.purpose === 'anthropic-upstream')?.staticModels ?? [];
    const values = (models: typeof codexModels, id: string) => models.find((model) => model.id === id)
      ?.modelOptions?.find((option) => option.id === 'reasoning_effort')?.options?.map((option) => option.value);

    expect(values(codexModels, 'codex-auto-review')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(values(codexModels, 'gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(values(claudeModels, 'claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(values(claudeModels, 'claude-opus-4-7')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(values(claudeModels, 'claude-opus-4-5-20251101')).toBeUndefined();
    expect(values(claudeModels, 'claude-3-5-haiku-20241022')).toBeUndefined();
    expect(values(codexModels, 'gpt-image-2')).toBeUndefined();
    for (const model of [...codexModels, ...claudeModels]) {
      for (const option of model.modelOptions ?? []) {
        expect(option.type).toBe('select');
        expect(option.options?.some((choice) => choice.value === option.currentValue)).toBe(true);
      }
    }
  });

  it('declares one discovery-backed aggregator for adopted local and explicit remote connections', () => {
    const parsed = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);

    expect(parsed).toMatchObject({
      v: 1,
      id: 'cliproxyapi',
      kind: 'aggregator',
      endpointTemplates: [
        {
          id: 'cliproxyapi-openai-responses',
          protocol: 'openai-responses',
          localUrlCandidates: [
            'http://127.0.0.1:8317/v1',
            'http://localhost:8317/v1',
          ],
        },
        {
          id: 'cliproxyapi-openai-chat',
          protocol: 'openai-chat',
          localUrlCandidates: [
            'http://127.0.0.1:8317/v1',
            'http://localhost:8317/v1',
          ],
        },
        {
          id: 'cliproxyapi-anthropic',
          protocol: 'anthropic',
          localUrlCandidates: [
            'http://127.0.0.1:8317/',
            'http://localhost:8317/',
          ],
        },
      ],
      discovery: {
        listener: {
          executableBasenames: ['CLIProxyAPI', 'CLIProxyAPI.exe', 'cli-proxy-api', 'cli-proxy-api.exe'],
          defaultPorts: [8317],
        },
        availabilityProbe: {
          endpointTemplateId: 'cliproxyapi-openai-responses',
          path: '/v1/models',
          parser: 'openai-models',
        },
      },
    });
    expect(ProviderContributionV1Schema.parse(parsed)).toEqual(parsed);
  });

  it('uses ordinary optional downstream bearer materialization and the canonical model catalog', () => {
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION).toMatchObject({
      credential: {
        kind: 'apiKey',
        required: false,
        transports: [{
          protocols: ['openai-chat', 'openai-responses', 'anthropic'],
          uses: ['probe', 'runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      managedRuntime: {
        kind: 'managed',
        connectedAccountPurposeBindingPolicy: { minimumBound: 1 },
        connectedAccounts: [{
          purpose: 'openai-upstream',
          title: {
            key: 'managedPurpose.openai.title',
            fallback: 'ChatGPT account or pool',
          },
        }, {
          purpose: 'anthropic-upstream',
          title: {
            key: 'managedPurpose.anthropic.title',
            fallback: 'Claude account or pool',
          },
        }],
      },
      catalog: {
        source: 'probe',
        manualModelPolicy: 'allowed',
        sourceRegistryVersion: 'v8.0.61:reasoning-image-capabilities-v2',
        probes: [{
          endpointTemplateId: 'cliproxyapi-openai-responses',
          path: '/v1/models',
          parser: 'openai-models',
        }],
      },
    });
  });

  it('does not grant management or Connected Services authority to adopted external instances', () => {
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION).not.toHaveProperty('modelLoad');
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION).not.toHaveProperty('managedEndpoint');
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION).not.toHaveProperty('connectedAccounts');
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION.discovery).not.toHaveProperty('managedStart');
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION.discovery).not.toHaveProperty('installedCheck');
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION.discovery).not.toHaveProperty('presenceCheck');
  });
});
