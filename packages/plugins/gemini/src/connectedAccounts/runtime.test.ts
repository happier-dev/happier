import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import { derivePluginAccountContributionRegistrationRights } from '../../../../protocol/src/plugins/contributions/catalog.js';
import { createPluginRegistrationScope } from '../../../../plugin-sdk/src/registration/scope.js';
import { invokeConnectedAccountAuthenticationRuntime } from '../../../../cli-common/src/connectedAccounts/authenticationRuntimeDispatcher.js';

function credentialStore(values = new Map<string, string>()) {
  return {
    values,
    store: {
      async get(key: string) { return values.get(key) ?? null; },
      async set(key: string, value: string) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
    },
  };
}

const kits: Awaited<ReturnType<typeof createPluginTestkit>>[] = [];
afterEach(async () => { await Promise.all(kits.splice(0).map(kit => kit.dispose())); });

async function activateConnectedAccountRuntime(): Promise<PluginConnectedAccountRuntime> {
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  kits.push(kit);
  const runtime = kit.registration('connectedAccountDescriptors', 'gemini-account');
  if (!runtime) throw new Error('Gemini Connected Account runtime was not registered');
  return runtime;
}

describe('Gemini Connected Account modes', () => {
  it('activates both manual modes in the Account realm and validates through the shared dispatcher without HTTP', async () => {
    const target = { artifactId: 'connected-account-authentication', exportName: 'activate' };
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors![0]!;
    expect(descriptor.authentication.account).toEqual(target);
    const artifactPath = './portableAuthentication.js';
    const artifact = await import(artifactPath) as { activate(api: PluginAccountApi): void };
    const scope = createPluginRegistrationScope({ pluginId: PLUGIN_MANIFEST.id, target: { realm: 'account', ...target },
      rights: derivePluginAccountContributionRegistrationRights(PLUGIN_MANIFEST.contributes, target) });
    artifact.activate(scope.api);
    const [registration] = scope.commit();
    if (registration?.family !== 'connectedAccountDescriptors') throw new Error('Gemini Account runtime was not registered');
    expect(Object.keys(registration.value.authentication.modes).sort()).toEqual(['api-key', 'service-account']);
    const staged = credentialStore();
    const service = { pluginId: PLUGIN_MANIFEST.id, localId: 'gemini-account' };
    const controller = new AbortController();
    const context = {
      plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
      surface: 'ui', invokedAtMs: 1, service, attempt: { kind: 'connect', attemptId: 'portable-gemini' },
      configuration: { target: { kind: 'attempt', attemptId: 'portable-gemini', service, modeId: 'api-key' }, revision: '1', values: {}, async getSecret() { return null; } },
      signal: controller.signal, attemptCredentials: staged.store,
      services: { http: createPluginHttpFixture({ async request() { throw new Error('Gemini manual save must not use HTTP'); } }) },
    } satisfies ConnectedAccountAuthenticationContext;
    const invoke = (modeId: string, fields: Readonly<Record<string, string>>) =>
      invokeConnectedAccountAuthenticationRuntime({ mode: registration.value.authentication.modes[modeId], descriptor: descriptor.authentication.modes.find(mode => mode.id === modeId)!,
        operation: { kind: 'submitManual', fields }, context: { ...context,
          configuration: { ...context.configuration, target: { ...context.configuration.target, modeId } } },
        registerRawForRedaction() {}, async invokeCallback(work) { return work(); } });
    expect(await invoke('api-key', { token: ' gemini-private ' })).toMatchObject({ status: 'connected' });
    expect(staged.values.get('apiKey')).toBe('gemini-private');
    staged.values.clear();
    expect(await invoke('service-account', { credentialsJson: '{' })).toMatchObject({ status: 'rejected', diagnostic: { code: 'gemini_service_account_invalid' } });
    expect(staged.values.size).toBe(0);
    const credentialsJson = JSON.stringify({ type: 'service_account', client_id: '123456789012345678901', client_email: 'worker@example.iam.gserviceaccount.com', project_id: 'project-one', private_key: 'fixture-private-key' });
    expect(await invoke('service-account', { credentialsJson })).toMatchObject({ status: 'connected', accountId: '123456789012345678901' });
    expect(JSON.parse(staged.values.get('serviceAccountJson')!)).toMatchObject({ project_id: 'project-one' });
  });

  it('declares and registers API-key plus service-account modes', async () => {
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toContainEqual({
      id: 'gemini-account',
      title: 'Gemini',
      authentication: {
        account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
        defaultModeId: 'api-key',
        modes: [
          expect.objectContaining({ id: 'api-key', kind: 'manual', accountDirectSave: { fieldKeys: { token: 'apiKey' } } }),
          expect.objectContaining({ id: 'service-account', kind: 'manual' }),
        ],
      },
    });
    const modes = (await activateConnectedAccountRuntime()).authentication.modes;
    expect(modes).toMatchObject({
      'api-key': { kind: 'manual' },
      'service-account': { kind: 'manual' },
    });
    expect(modes).not.toHaveProperty('legacy-oauth-unsupported');
  });

  it('materializes API keys to requested Gemini environment keys', async () => {
    const runtime = await activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes['api-key'];
    if (!mode || mode.kind !== 'manual') throw new Error('Gemini API-key mode is unavailable');
    const attempted = credentialStore();
    const connected = await mode.complete({ fields: { token: ' gemini-key ' } }, {
      attempt: { kind: 'connect', attemptId: 'gemini-api-attempt' },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1]);
    expect(connected).toMatchObject({
      status: 'connected',
    });
    if (connected.status !== 'connected') throw new Error('Gemini API-key connect was rejected');
    expect(connected).not.toHaveProperty('accountId');
    expect(attempted.values).toEqual(new Map([['apiKey', 'gemini-key']]));

    const replacement = credentialStore();
    await expect(mode.complete({ fields: { token: 'replacement-key' } }, {
      attempt: {
        kind: 'reconnect',
        attemptId: 'gemini-api-reconnect',
        account: {
          service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
          accountId: 'gemini-api-account',
        },
      },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: replacement.store,
    } as Parameters<typeof mode.complete>[1])).resolves.toMatchObject({
      status: 'connected',
      accountId: 'gemini-api-account',
    });

    await expect(runtime.materialize(
      { kind: 'environment', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
      {
        account: {
          service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
          accountId: 'gemini-api-account',
        },
        configuration: {
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
              accountId: 'gemini-api-account',
            },
            modeId: 'api-key',
          },
          revision: 'configuration-1',
          values: {},
          async getSecret() { return null; },
        },
        signal: new AbortController().signal,
        services: {},
        credentials: attempted.store,
      } as Parameters<typeof runtime.materialize>[1],
    )).resolves.toEqual({
      kind: 'environment',
      env: { GEMINI_API_KEY: 'gemini-key', GOOGLE_API_KEY: 'gemini-key' },
    });
  });

  it('validates service-account JSON before staging it and materializes an exact credential file', async () => {
    const runtime = await activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes['service-account'];
    if (!mode || mode.kind !== 'manual') throw new Error('Gemini service-account mode is unavailable');
    const attempted = credentialStore();
    await expect(mode.complete({
      fields: {
        credentialsJson: JSON.stringify({
          type: 'service_account',
          client_id: '123456789012345678901',
          client_email: 'worker@example.iam.gserviceaccount.com',
          project_id: 'project-one',
          private_key: 'secret-private-key',
        }),
      },
    }, {
      attempt: { kind: 'connect', attemptId: 'gemini-service-attempt' },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: attempted.store,
    } as Parameters<typeof mode.complete>[1])).resolves.toEqual({
      status: 'connected',
      accountId: '123456789012345678901',
      providerIdentity: {
        email: 'worker@example.iam.gserviceaccount.com',
      },
      displayName: 'worker@example.iam.gserviceaccount.com',
      scopes: [],
    });
    expect(attempted.values.get('serviceAccountJson')).not.toContain(' ');

    const readContext = {
      account: {
        service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
        accountId: '123456789012345678901',
      },
      configuration: {
        target: {
          kind: 'account',
            account: {
              service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
              accountId: '123456789012345678901',
            },
            modeId: 'service-account',
        },
        revision: 'configuration-1',
        values: {},
        async getSecret() { return null; },
      },
      signal: new AbortController().signal,
      services: {},
      credentials: attempted.store,
    } as Parameters<typeof runtime.materialize>[1];
    const materialized = await runtime.materialize(
      { kind: 'files', fileIds: ['google-service-account.json'] },
      readContext,
    );
    expect(materialized).toMatchObject({
      kind: 'files',
      files: { 'google-service-account.json': expect.any(Uint8Array) },
    });
    if (materialized.kind !== 'files') return;
    expect(JSON.parse(new TextDecoder().decode(
      materialized.files['google-service-account.json'],
    ))).toMatchObject({
      client_id: '123456789012345678901',
      client_email: 'worker@example.iam.gserviceaccount.com',
      project_id: 'project-one',
    });
    await expect(runtime.materialize(
      {
        kind: 'environment',
        keys: [
          'GOOGLE_GENAI_USE_VERTEXAI',
          'GOOGLE_CLOUD_PROJECT',
          'GOOGLE_CLOUD_LOCATION',
        ],
      },
      readContext,
    )).resolves.toEqual({
      kind: 'environment',
      env: {
        GOOGLE_GENAI_USE_VERTEXAI: '1',
        GOOGLE_CLOUD_PROJECT: 'project-one',
        GOOGLE_CLOUD_LOCATION: 'global',
      },
    });

    const rejected = credentialStore();
    await expect(mode.complete({ fields: { credentialsJson: '{' } }, {
      attempt: { kind: 'connect', attemptId: 'gemini-invalid' },
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: rejected.store,
    } as Parameters<typeof mode.complete>[1])).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'gemini_service_account_invalid' },
    });
    expect(rejected.values).toEqual(new Map());
  });

  it('uses the immutable service-account client ID and exposes reconnect identity mismatches', async () => {
    const runtime = await activateConnectedAccountRuntime();
    const mode = runtime.authentication.modes['service-account'];
    if (!mode || mode.kind !== 'manual') throw new Error('Gemini service-account mode is unavailable');
    const complete = async (
      clientId: string,
      attempt: Parameters<typeof mode.complete>[1]['attempt'],
    ) => mode.complete({
      fields: {
        credentialsJson: JSON.stringify({
          type: 'service_account',
          client_id: clientId,
          client_email: 'reused@example.iam.gserviceaccount.com',
          project_id: 'project-one',
          private_key: 'secret-private-key',
        }),
      },
    }, {
      attempt,
      signal: new AbortController().signal,
      services: {},
      attemptCredentials: credentialStore().store,
    } as Parameters<typeof mode.complete>[1]);

    await expect(complete('111111111111111111111', {
      kind: 'connect',
      attemptId: 'gemini-service-first',
    })).resolves.toMatchObject({
      status: 'connected',
      accountId: '111111111111111111111',
      providerIdentity: { email: 'reused@example.iam.gserviceaccount.com' },
    });
    await expect(complete('222222222222222222222', {
      kind: 'connect',
      attemptId: 'gemini-service-second',
    })).resolves.toMatchObject({
      status: 'connected',
      accountId: '222222222222222222222',
      providerIdentity: { email: 'reused@example.iam.gserviceaccount.com' },
    });
    await expect(complete('222222222222222222222', {
      kind: 'reconnect',
      attemptId: 'gemini-service-reconnect',
      account: {
        service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
        accountId: '111111111111111111111',
      },
    })).resolves.toMatchObject({
      status: 'connected',
      accountId: '222222222222222222222',
    });
  });
});
