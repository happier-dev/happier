import { describe, expect, it } from 'vitest';

import { ConnectedAccountUiProjectionEntryV1Schema, projectConnectedAccountDescriptorV1 } from './connectedAccountUiProjectionV1.js';
import { PluginConnectedAccountDescriptorContributionV2Schema } from './pluginConnectedAccountAuthenticationV2.js';
import { resolveConnectedAccountNativeLoginConstraintsV1 } from '../teams/credentials/teamCredentialModelCatalogV1.js';
import { AgentProviderRequirementsV1Schema } from '../providers/compatibility/v1.js';

describe('ConnectedAccountUiProjectionEntryV1', () => {
  it('projects native-login constraints from qualified Agent declarations without treating missing Agents as constraints', () => {
    const service = { pluginId: 'acme.login', localId: 'subscription' };
    const providerRequirements = AgentProviderRequirementsV1Schema.parse({ acceptsProtocols: ['openai-responses'], required: {},
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] }, authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
      materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: false });
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: service.localId, title: 'Acme',
      authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] } });
    const projected = projectConnectedAccountDescriptorV1({ descriptor, pluginId: service.pluginId, serviceId: service.localId,
      provenance: 'external', sourceKind: 'installed', availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
      nativeLoginRequiredBy: resolveConnectedAccountNativeLoginConstraintsV1(service, [{ identity: { pluginId: 'acme.agent', localId: 'native' }, title: 'Acme Native', connectedAccounts: [{ service }] },
        { identity: { pluginId: 'acme.agent', localId: 'brokerable' }, title: 'Acme Brokerable', providerRequirements, connectedAccounts: [{ service }] },
        { identity: { pluginId: 'foreign.agent', localId: 'native' }, title: 'Foreign Native',
          connectedAccounts: [{ service: { ...service, pluginId: 'foreign.login' } }] }]),
    });
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(projected).nativeLoginRequiredBy)
      .toEqual([{ identity: { pluginId: 'acme.agent', localId: 'native' }, title: 'Acme Native' }]);
    expect(projectConnectedAccountDescriptorV1({ descriptor, pluginId: service.pluginId, serviceId: service.localId,
      provenance: 'external', sourceKind: 'installed', availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }).nativeLoginRequiredBy)
      .toBeUndefined();
  });
  it('projects a dynamic service brand and setup presentation without borrowing built-in identity', () => {
    const ui = { iconResourceId: 'service-mark', shortName: 'Acme', setup: {
      order: 9, firstRun: true, catalogDescription: { key: 'acme.catalog', fallback: 'Use your Acme subscription' },
    } };
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: 'acme', title: 'Acme account', ui,
      authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] } });
    const projection = projectConnectedAccountDescriptorV1({ descriptor, pluginId: 'acme.account', serviceId: 'acme',
      provenance: 'external', sourceKind: 'installed', availability: { state: 'available', reason: 'resolved' }, diagnostics: [] });
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(projection).ui).toEqual(ui);
  });
  it('projects declaration-owned manual guidance and rejects credential-bearing console links', () => {
    const setup = { url: 'https://provider.test/keys', checklist: ['Create an API key.', { key: 'provider.copyKey', fallback: 'Copy the key here.' }] };
    const raw = { id: 'keys', title: 'Provider', authentication: {
      defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [], setup }],
    } };
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse(raw);
    const projected = projectConnectedAccountDescriptorV1({ descriptor, pluginId: 'acme.provider', serviceId: 'keys',
      provenance: 'external', sourceKind: 'installed', availability: { state: 'available', reason: 'resolved' }, diagnostics: [] });
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(projected).authentication.modes[0]).toMatchObject({ setup });
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...raw, ui: { manual: setup } }).success).toBe(false);
    for (const url of ['http://provider.test/keys', 'https://secret@provider.test/keys']) {
      expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...raw, authentication: {
        ...raw.authentication, modes: [{ ...raw.authentication.modes[0], setup: { ...setup, url } }],
      } }).success).toBe(false);
    }
  });
  it('keeps per-feature permissions and Advanced fields of a manual mode through the projection', () => {
    const permissions = [{ feature: 'Workers', items: ['Workers Scripts: Edit', { key: 'provider.ci', fallback: 'Workers CI: Edit' }] }];
    const field = { id: 'clientId', title: 'Client ID', schema: { type: 'string' }, presentation: { advanced: true } };
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: 'keys', title: 'Provider', authentication: {
      defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [field],
        setup: { url: 'https://provider.test/keys', checklist: ['Create a token.'], permissions } }],
    } });
    const projected = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({ descriptor, pluginId: 'acme.provider', serviceId: 'keys',
      provenance: 'external', sourceKind: 'installed', availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }));
    expect(projected.authentication.modes[0]).toMatchObject({ setup: { permissions }, fields: [{ presentation: { advanced: true } }] });
  });
  it('keeps a browser sign-in mode\u2019s own-client guide through the projection', () => {
    const setup = { url: 'https://provider.test/clients', checklist: ['Register a client'], permissions: [{ feature: 'Workers', items: ['Scripts: Edit'] }] };
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: 'oauth', title: 'Provider', authentication: {
      defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://app.test/callback',
        pkce: 'required', outcomeReconciliation: 'none', setup }],
    } });
    const projected = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({ descriptor, pluginId: 'acme.provider', serviceId: 'oauth',
      provenance: 'external', sourceKind: 'installed', availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }));
    expect(projected.authentication.modes[0]).toMatchObject({ setup });
  });
  it('projects optional Cloud machines presentation from an external descriptor without granting availability', () => {
    const raw = { id: 'cloud', title: 'Acme Cloud', ui: { category: 'cloud-machines' }, authentication: {
      defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }],
    } };
    const declared = PluginConnectedAccountDescriptorContributionV2Schema.safeParse(raw);
    expect(declared.success).toBe(true);
    if (!declared.success) return;
    const projected = projectConnectedAccountDescriptorV1({ descriptor: declared.data, pluginId: 'acme.cloud', serviceId: 'cloud',
      provenance: 'external', sourceKind: 'installed', availability: { state: 'blocked', reason: 'configuration-required' }, diagnostics: [] });
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(projected)).toMatchObject({ ui: { category: 'cloud-machines' },
      availability: { state: 'blocked', reason: 'configuration-required' } });
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...raw, ui: { category: 'cloud-machines', execute: 'hook' } }).success).toBe(false);
  });
  it('preserves every serializable authentication mode and configuration form fact', () => {
    const input = {
      id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled',
      title: 'Bitbucket account',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          outcomeReconciliation: 'providerCheck',
          scopes: ['account.read'],
          configuration: {
            scope: 'account',
            changeBehavior: 'refresh',
            fields: [{
              id: 'tenant',
              title: 'Tenant',
              schema: { type: 'string', minLength: 1 },
              secret: false,
              default: 'main',
              required: true,
              presentation: { control: 'text' },
            }],
          },
        }],
      },
      capabilities: [],
      recoveryCredits: { supported: true },
      billingUrl: 'https://provider.test/billing',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    };
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(input)).toEqual(input);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, billingUrl: undefined }).success).toBe(true);
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(input).authentication.modes).toHaveLength(2);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, hookKey: 'execute-me' }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({
      ...input,
      authentication: {
        ...input.authentication,
        modes: [{
          ...input.authentication.modes[1],
          configuration: {
            ...input.authentication.modes[1]?.configuration,
            fields: [{
              id: 'clientSecret',
              title: 'Client secret',
              schema: { type: 'string' },
              secret: true,
              value: 'must-not-project',
            }],
          },
        }],
      },
    }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({
      ...input,
      authentication: {
        ...input.authentication,
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'https://provider.example/oauth/callback',
          pkce: 'required',
          outcomeReconciliation: 'none',
          clientSecretEnvKey: 'OAUTH_CLIENT_SECRET',
        }],
      },
    }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({
      ...input,
      authentication: {
        ...input.authentication,
        modes: [{
          id: 'legacy',
          kind: 'hostAdapter',
          adapter: 'githubOAuth',
        }],
      },
    }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, pluginId: '../bad-plugin' }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, serviceId: 'forge' }).success).toBe(true);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, pluginId: undefined, serviceId: 'unregistered-service' }).success).toBe(false);
  });
});
