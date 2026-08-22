import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol';

import { createPluginWebhookActionExecutor } from './pluginWebhookActionExecutor';

const transportMocks = vi.hoisted(() => ({
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
}));

vi.mock('axios', () => ({ default: { post: transportMocks.post } }));
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: transportMocks.createPublisherHeader,
}));

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};
const callerMaterialization = {
  pluginId: 'happier.channels',
  machineId: 'machine-caller',
  materializationId: 'materialization-caller',
} as const;
const correspondenceSetup = {
  kind: 'githubAccountEndpointV1',
  credential: 'serverGenerated',
} as const;

describe('createPluginWebhookActionExecutor', () => {
  it('signs and sends the exact stamped caller materialization on the correspondence HTTP path', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: {
        kind: 'ready',
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 1,
      },
    });
    const executor = createPluginWebhookActionExecutor({
      credentials,
      revalidateCallerMaterialization: async () => true,
    });
    const input = {
      webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      webhookContribution: { pluginId: 'acme.github', localId: 'issues' },
      targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
      sourceInstanceId: 'source-1',
      setup: correspondenceSetup,
    };

    await expect(executor({
      actionId: 'plugin.webhook.endpoint.checkCorrespondence',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      kind: 'ready',
      webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      revision: 1,
    });

    const body = {
      caller: {
        ...callerMaterialization,
      },
      input,
    };
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/plugins/webhooks/endpoints/check-correspondence',
      body,
    });
    expect(transportMocks.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/plugins\/webhooks\/endpoints\/check-correspondence$/u),
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'publisher-proof',
        }),
      }),
    );
  });

  it('routes present-user operations with host provenance and plugin correspondence with stamped caller identity', async () => {
    const execute = vi.fn(async (_actionId: string) => ({ kind: 'ok' }));
    const revalidateCallerMaterialization = vi.fn(async () => true);
    const executor = createPluginWebhookActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
    });
    const input = { webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw' };

    await executor({
      actionId: 'plugin.webhook.endpoint.read',
      input,
      caller: { kind: 'host' },
    });
    await executor({
      actionId: 'plugin.webhook.endpoint.checkCorrespondence',
      input: {
        ...input,
        webhookContribution: { pluginId: 'acme.github', localId: 'issues' },
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        sourceInstanceId: 'source-1',
        setup: correspondenceSetup,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        materialization: callerMaterialization,
      },
    });

    expect(execute).toHaveBeenNthCalledWith(1, 'plugin.webhook.endpoint.read', input, {});
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'plugin.webhook.endpoint.checkCorrespondence',
      expect.objectContaining({ webhookEndpointId: input.webhookEndpointId }),
      {
        caller: {
          ...callerMaterialization,
        },
      },
    );
    expect(revalidateCallerMaterialization).toHaveBeenCalledOnce();
    expect(revalidateCallerMaterialization).toHaveBeenCalledWith(callerMaterialization);
  });

  it('fails closed before transport when the stamped caller materialization is absent or no longer current', async () => {
    const execute = vi.fn();
    const executor = createPluginWebhookActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => false,
    });

    await expect(executor({
      actionId: 'plugin.webhook.endpoint.checkCorrespondence',
      input: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        webhookContribution: { pluginId: 'acme.github', localId: 'issues' },
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        sourceInstanceId: 'source-1',
        setup: correspondenceSetup,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        materialization: callerMaterialization,
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_webhook_caller_materialization_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(executor({
      actionId: 'plugin.webhook.endpoint.checkCorrespondence',
      input: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        webhookContribution: { pluginId: 'acme.github', localId: 'issues' },
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        sourceInstanceId: 'source-1',
        setup: correspondenceSetup,
      },
      caller: { kind: 'plugin', pluginId: 'happier.channels' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_webhook_caller_materialization_unavailable',
    });
  });

  it('fails closed before transport when the resolved runtime has no currentness owner', async () => {
    const execute = vi.fn();
    const executor = createPluginWebhookActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'plugin.webhook.endpoint.checkCorrespondence',
      input: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        webhookContribution: { pluginId: 'acme.github', localId: 'issues' },
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        sourceInstanceId: 'source-1',
        setup: correspondenceSetup,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        materialization: callerMaterialization,
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_webhook_caller_materialization_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when caller surface provenance does not match the Action contract', async () => {
    const execute = vi.fn();
    const executor = createPluginWebhookActionExecutor({ credentials, transport: { execute } });

    await expect(executor({
      actionId: 'plugin.webhook.endpoint.read',
      input: { webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw' },
      caller: { kind: 'plugin', pluginId: 'acme.plugin' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'plugin_webhook_caller_surface_mismatch' });
    await expect(executor({
      actionId: 'plugin.webhook.endpoint.checkCorrespondence',
      input: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        webhookContribution: { pluginId: 'acme.github', localId: 'issues' },
        targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
        sourceInstanceId: 'source-1',
        setup: correspondenceSetup,
      },
      caller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'plugin_webhook_caller_surface_mismatch' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects caller identity embedded in plugin Action input before constructing the private transport body', async () => {
    transportMocks.post.mockClear();
    transportMocks.createPublisherHeader.mockClear();
    const executor = createPluginWebhookActionExecutor({
      credentials,
      revalidateCallerMaterialization: async () => true,
    });
    const forgedInput = {
      webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      webhookContribution: { pluginId: 'acme.github', localId: 'issues' },
      targetMaterialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
      sourceInstanceId: 'source-1',
      setup: correspondenceSetup,
      caller: { pluginId: 'forged.plugin', materializationId: 'forged-materialization' },
    };

    await expect(executor({
      actionId: 'plugin.webhook.endpoint.checkCorrespondence',
      input: forgedInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        materialization: callerMaterialization,
      },
    })).rejects.toThrow();
    expect(transportMocks.createPublisherHeader).not.toHaveBeenCalled();
    expect(transportMocks.post).not.toHaveBeenCalled();
  });
});
