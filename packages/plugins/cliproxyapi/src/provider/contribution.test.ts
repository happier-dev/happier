import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from './contribution.js';

describe('CLIPROXYAPI_PROVIDER_CONTRIBUTION', () => {
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
      catalog: {
        source: 'probe',
        manualModelPolicy: 'allowed',
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
