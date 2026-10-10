import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from './contribution.js';
import {
  projectCLIProxyAPIProviderConnectionApplication,
  resolveCLIProxyAPIManagedBrokerApplication,
  resolveCLIProxyAPIManagedPurposeFamily,
} from './managedContract.js';

describe('CLIPROXYAPI_PROVIDER_CONTRIBUTION', () => {
  it('owns source-qualified upstream purposes independently of the exact downstream endpoint/protocol', () => {
    expect(resolveCLIProxyAPIManagedPurposeFamily({
      endpointTemplateId: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses',
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
    })?.purpose).toBe('openai-upstream');
    expect(resolveCLIProxyAPIManagedPurposeFamily({
      endpointTemplateId: 'cliproxyapi-anthropic',
      protocol: 'anthropic',
      service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
    })?.purpose).toBe('anthropic-upstream');
    expect(resolveCLIProxyAPIManagedPurposeFamily({
      endpointTemplateId: 'cliproxyapi-anthropic',
      protocol: 'openai-responses',
      service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
    })).toBeNull();
    expect(resolveCLIProxyAPIManagedBrokerApplication({
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      protocol: 'anthropic',
    })?.endpointTemplateId).toBe('cliproxyapi-anthropic');
    expect(resolveCLIProxyAPIManagedBrokerApplication({
      service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
      protocol: 'openai-responses',
    })?.endpointTemplateId).toBe('cliproxyapi-openai-responses');
    expect(resolveCLIProxyAPIManagedBrokerApplication({
      service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
      protocol: 'openai-chat',
    })?.endpointTemplateId).toBe('cliproxyapi-openai-chat');
    expect(resolveCLIProxyAPIManagedBrokerApplication({
      service: { pluginId: 'foreign', localId: 'openai-codex' },
      protocol: 'anthropic',
    })).toBeNull();
    expect(resolveCLIProxyAPIManagedBrokerApplication({
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      protocol: 'unsupported',
    })).toBeNull();
    expect(resolveCLIProxyAPIManagedBrokerApplication({
      service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
      protocol: 'anthropic',
    })?.endpointTemplateId).toBe('cliproxyapi-anthropic');
  });

  it('projects Provider Connection traffic onto the same managed executable without changing its Agent target', () => {
    expect(projectCLIProxyAPIProviderConnectionApplication({
      agentTargetKey: 'agent:example/custom',
      protocol: 'openai-chat',
    })).toEqual({
      agentTargetKey: 'agent:example/custom',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-chat',
      protocol: 'openai-chat',
    });
    expect(projectCLIProxyAPIProviderConnectionApplication({
      agentTargetKey: 'agent:example/custom',
      protocol: 'unsupported',
    })).toBeNull();
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
        sourceRegistryVersion: 'v7.2.95',
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
