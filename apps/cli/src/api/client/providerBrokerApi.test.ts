import axios from './credentialAxios';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1 } from '@happier-dev/protocol';
import { GITHUB_BROKER_WATCHER_V1, ProviderBrokerWatcherOpenRequestV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { describe, expect, it, vi } from 'vitest';

import { openTeamCredentialProviderBroker } from './providerBrokerApi';

vi.mock('./credentialAxios', () => ({
  default: { post: vi.fn() },
}));

describe('Provider broker narrow HTTP API', () => {
  it('opens one exact typed broker request with only the injected bearer and origin', async () => {
    const request = {
      v: 1 as const,
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      modelId: 'gpt-5',
      sourceRevision: 'source-3',
      initiatorMachineId: 'worker-1',
      consumer: { kind: 'session' as const, sessionId: 'session-1' },
      application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
        endpointTemplateId: 'responses',
        protocol: 'openai-responses' as const,
      },
    };
    const response = { ok: false as const, reasonCode: 'broker_unavailable' as const };
    vi.mocked(axios.post).mockResolvedValueOnce({ data: response });

    await expect(openTeamCredentialProviderBroker({
      serverBaseUrl: 'https://home.example.test/',
      token: 'runner-token',
      request,
      signal: new AbortController().signal,
    })).resolves.toEqual(response);

    expect(axios.post).toHaveBeenCalledWith(
      `https://home.example.test${PROVIDER_BROKER_OPEN_HTTP_PATH_V1}`,
      request,
      {
        headers: { Authorization: 'Bearer runner-token', 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('opens a watcher grant with the exact publisher proof and Machine bearer', async () => {
    const pluginId = GITHUB_BROKER_WATCHER_V1.service.pluginId;
    const request = ProviderBrokerWatcherOpenRequestV1Schema.parse({
      v: 1, scope: 'automation_event_watcher', resourceId: 'resource-1', initiatorMachineId: 'worker-1',
      caller: {
        pluginId, occurrenceId: 'occurrence-1', contributionLocalId: GITHUB_BROKER_WATCHER_V1.backgroundServiceId,
        sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'archive' },
        materialization: { pluginId, machineId: 'worker-1', materializationId: 'materialization-1' },
      },
    });
    const response = { ok: false, reasonCode: 'broker_unavailable' };
    vi.mocked(axios.post).mockResolvedValueOnce({ data: response });

    await expect(openTeamCredentialProviderBroker({
      serverBaseUrl: 'https://home.example.test/', token: 'machine-token', request,
      requestHeaders: { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'signed-publisher-proof' },
    })).resolves.toEqual(response);

    expect(axios.post).toHaveBeenLastCalledWith(`https://home.example.test${PROVIDER_BROKER_OPEN_HTTP_PATH_V1}`, request, {
      headers: {
        Authorization: 'Bearer machine-token', 'Content-Type': 'application/json',
        [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'signed-publisher-proof',
      },
      maxRedirects: 0,
    });
  });
});
