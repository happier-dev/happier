import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Credentials } from '@/persistence';

const {
  callMachineRpc,
  readStoredCredentials,
  resolvePluginInvocationLogTarget,
  resolveMergedContributionRegistry,
} = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
  readStoredCredentials: vi.fn(),
  resolvePluginInvocationLogTarget: vi.fn(),
  resolveMergedContributionRegistry: vi.fn(),
}));

vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
  callMachineRpc,
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials,
}));

vi.mock('@/cli/commands/pluginInvocationLogsMachine', () => ({
  resolvePluginInvocationLogTarget,
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  resolveMergedContributionRegistry,
}));

import {
  executePluginSettingsAdministrationAction,
  projectAccountSettingsAdministrationSnapshot,
} from './administration';

const credentials: Credentials = {
  token: 'account-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

const target = {
  kind: 'daemon' as const,
  serverIdentityId: 'srv_settings_1',
  machineId: 'machine-1',
};

const listRequest = {
  actionId: 'plugins.settings.list' as const,
  input: {
    pluginId: 'acme.settings',
    scope: { kind: 'daemon' as const },
    target,
  },
};

describe('Plugin Settings administration daemon transport', () => {
  beforeEach(() => {
    callMachineRpc.mockReset();
    readStoredCredentials.mockReset();
    resolvePluginInvocationLogTarget.mockReset();
    resolveMergedContributionRegistry.mockReset();
    readStoredCredentials.mockResolvedValue(credentials);
    resolvePluginInvocationLogTarget.mockResolvedValue({
      kind: 'selected',
      target: {
        serverIdentityId: target.serverIdentityId,
        machineId: target.machineId,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
  ])('maps an older daemon receiver absence (%s) to typed unsupported without another owner', async (rpcErrorCode) => {
    callMachineRpc.mockRejectedValue(createRpcCallError({
      error: 'The selected daemon has no Plugin Settings administration receiver.',
      errorCode: rpcErrorCode,
    }));

    await expect(executePluginSettingsAdministrationAction(listRequest)).resolves.toMatchObject({
      ok: false,
      kind: 'plugins.settings.list',
      errorCode: 'plugin_settings_daemon_unsupported',
    });
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: target.machineId,
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    }));
  });

  it('fails the exact target currentness check before any daemon read', async () => {
    resolvePluginInvocationLogTarget.mockResolvedValue({
      kind: 'selected',
      target: {
        serverIdentityId: 'srv_replaced_1',
        machineId: target.machineId,
      },
    });

    await expect(executePluginSettingsAdministrationAction(listRequest)).resolves.toMatchObject({
      ok: false,
      kind: 'plugins.settings.list',
      errorCode: 'plugin_settings_target_not_current',
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('preserves cancellation instead of turning it into availability', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(executePluginSettingsAdministrationAction({
      ...listRequest,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(resolvePluginInvocationLogTarget).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('does not route daemon secret unbind through the destructive delete receiver', async () => {
    resolveMergedContributionRegistry.mockResolvedValue({
      activationTargets: [{
        pluginId: 'acme.settings',
        manifest: {
          secrets: [{ id: 'daemon-token', custody: 'daemon' }],
          contributes: {},
        },
      }],
    });

    await expect(executePluginSettingsAdministrationAction({
      actionId: 'plugins.settings.secret.unbind',
      input: {
        pluginId: 'acme.settings',
        localId: 'daemon-token',
        secretDaemonTarget: target,
      },
    })).resolves.toMatchObject({
      ok: false,
      kind: 'plugins.settings.secret.unbind',
      errorCode: 'plugin_settings_secret_binding_unavailable',
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

});

describe('Plugin Settings administration declaration defaults', () => {
  const projectedField = (
    field: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> => ({
    kind: 'settings.field',
    version: '1.0.0',
    secretCustody: null,
    ...field,
  });

  const projection = {
    protocolVersion: 1,
    projection: {
      v: 2,
      generation: 1,
      settingsById: {
        'acme.settings/main': {
          id: 'main',
          pluginId: 'acme.settings',
          version: 1,
          title: 'Acme',
          scope: { kind: 'daemon' },
          presentation: {},
          target: { kind: 'plugin' },
          fields: [
            projectedField({
              id: 'retries',
              valueSchema: { type: 'number' },
              valueType: 'number',
              control: 'number',
              displayKey: 'Retries',
              defaultValue: 3,
            }),
            projectedField({
              id: 'endpoint',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'text',
              displayKey: 'Endpoint',
              defaultValue: 'https://declared.example',
            }),
            projectedField({
              id: 'nullable',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'text',
              displayKey: 'Nullable',
              defaultValue: 'declared-fallback',
            }),
            projectedField({
              id: 'undeclared',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'text',
              displayKey: 'Undeclared',
            }),
          ],
        },
      },
    },
  };

  const snapshot = {
    protocolVersion: 1,
    pluginId: 'acme.settings',
    scope: { kind: 'daemon' },
    revision: '7',
    // Sparse by construction: only `nullable` was ever written, and it was
    // written as an explicit JSON null.
    values: { nullable: null },
    redactedKeys: [],
  };

  beforeEach(() => {
    callMachineRpc.mockReset();
    readStoredCredentials.mockReset();
    resolvePluginInvocationLogTarget.mockReset();
    readStoredCredentials.mockResolvedValue(credentials);
    resolvePluginInvocationLogTarget.mockResolvedValue({
      kind: 'selected',
      target: {
        serverIdentityId: target.serverIdentityId,
        machineId: target.machineId,
      },
    });
    callMachineRpc.mockImplementation(async (params: { method: string }) => {
      if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return projection;
      }
      if (params.method === RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET) return snapshot;
      throw new Error(`Unexpected daemon method ${params.method}`);
    });
  });

  it('lists the declared default for an absent value and keeps an explicit null', async () => {
    const listed = await executePluginSettingsAdministrationAction(listRequest);

    expect(listed).toMatchObject({ ok: true, kind: 'plugins.settings.list' });
    expect(listed.ok && listed.kind === 'plugins.settings.list' ? listed.data.fields : null)
      .toEqual([
        { localId: 'retries', secret: false, value: 3 },
        { localId: 'endpoint', secret: false, value: 'https://declared.example' },
        { localId: 'nullable', secret: false, value: null },
        { localId: 'undeclared', secret: false, value: null },
      ]);
  });

  it('gets the declared default for an absent value instead of reporting the daemon unsupported', async () => {
    await expect(executePluginSettingsAdministrationAction({
      actionId: 'plugins.settings.get',
      input: {
        pluginId: 'acme.settings',
        scope: { kind: 'daemon' as const },
        target,
        localId: 'retries',
      },
    })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins.settings.get',
      data: { localId: 'retries', value: 3 },
    });
  });

  it('gets an explicit null rather than substituting the declared default', async () => {
    await expect(executePluginSettingsAdministrationAction({
      actionId: 'plugins.settings.get',
      input: {
        pluginId: 'acme.settings',
        scope: { kind: 'daemon' as const },
        target,
        localId: 'nullable',
      },
    })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins.settings.get',
      data: { localId: 'nullable', value: null },
    });
  });
});

describe('Plugin Settings Account administration snapshot projection', () => {
  const descriptors = [
    {
      id: 'endpoint',
      title: 'Endpoint',
      target: { kind: 'plugin' as const },
      scope: 'account' as const,
      schema: { type: 'string' as const },
      default: 'https://default.example',
    },
    {
      id: 'endpointByServer',
      title: 'Endpoint by server',
      target: { kind: 'plugin' as const },
      scope: 'account' as const,
      schema: { type: 'object' as const },
    },
  ];

  it('projects revision and effective values from one snapshot while hiding backing maps', () => {
    expect(projectAccountSettingsAdministrationSnapshot({
      descriptors,
      hiddenFieldIds: new Set(['endpointByServer']),
      snapshot: {
        scope: { kind: 'account' },
        revision: '41',
        values: {
          endpoint: 'https://snapshot.example',
          endpointByServer: { srv_one: 'https://hidden.example' },
        },
      },
    })).toEqual({
      scope: { kind: 'account' },
      revision: '41',
      fields: [{
        localId: 'endpoint',
        title: 'Endpoint',
        secret: false,
        value: 'https://snapshot.example',
      }],
    });
  });

  it('uses the declaration default only when the same snapshot has no own value', () => {
    expect(projectAccountSettingsAdministrationSnapshot({
      descriptors,
      hiddenFieldIds: new Set(['endpointByServer']),
      snapshot: { scope: { kind: 'account' }, revision: '42', values: {} },
    }).fields).toEqual([{
      localId: 'endpoint',
      title: 'Endpoint',
      secret: false,
      value: 'https://default.example',
    }]);
  });
});
