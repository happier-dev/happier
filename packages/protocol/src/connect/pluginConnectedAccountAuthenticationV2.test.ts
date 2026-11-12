import { describe, expect, it } from 'vitest';

import { resolveConnectedAccountAuthenticationModeMachineRequirement, PluginConnectedAccountAuthenticationModeV2Schema, PluginConnectedAccountConfigurationFieldV2Schema, PluginConnectedAccountDescriptorContributionV2Schema } from './pluginConnectedAccountAuthenticationV2.js';
import { ConnectedAccountUiProjectionEntryV1Schema, projectConnectedAccountDescriptorV1 } from './connectedAccountUiProjectionV1.js';

it('preserves an explicitly declared API-key mode through the public catalog descriptor without inferring other manual modes', () => {
  const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: 'vendor', title: 'Vendor', authentication: { defaultModeId: 'key', modes: [
      { id: 'key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', fields: [] },
      { id: 'existing', kind: 'manual', credentialOrigin: 'native_import', outcomeReconciliation: 'none', fields: [] },
      { id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] },
    ] },
  });
  const projection = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
    descriptor, serviceId: 'vendor', pluginId: 'acme.vendor', provenance: 'external', sourceKind: 'installed',
    availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
  }));
  expect(projection.authentication.modes[0]).toMatchObject({ apiKey: true });
  expect(projection.authentication.modes[1]).not.toHaveProperty('apiKey');
  expect(projection.authentication.modes[2]).not.toHaveProperty('apiKey');
});

it('preserves manual credential-check reachability through the UI projection', () => {
  const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: 'vendor', title: 'Vendor', authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', browserReachability: 'unreachable', outcomeReconciliation: 'none', fields: [],
    }] },
  });
  const projection = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
    descriptor, serviceId: 'vendor', pluginId: 'acme.vendor', provenance: 'external', sourceKind: 'installed',
    availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
  }));
  expect(projection.authentication.modes[0]).toMatchObject({ kind: 'manual', browserReachability: 'unreachable' });
});

it('preserves declared browser exchange reachability through the UI projection', () => {
  for (const kind of ['oauthAuthorizationCode', 'oauthDeviceCode'] as const) {
    const mode = { id: 'oauth', kind, outcomeReconciliation: 'none', browserReachability: 'unreachable',
      ...(kind === 'oauthAuthorizationCode' ? { callbackUrl: 'https://callback.test', pkce: 'required' } : {}) };
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: 'example', title: 'Example', authentication: { defaultModeId: 'oauth', modes: [mode] },
    });
    const projection = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
      descriptor, serviceId: 'example', pluginId: 'acme.example', provenance: 'external', sourceKind: 'installed',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }));
    expect(projection.authentication.modes[0]).toMatchObject({ browserReachability: 'unreachable' });
    for (const browserReachability of ['reachable', 'unknown', 'maybe']) {
      expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, browserReachability }).success).toBe(false);
    }
  }
});

it('defers only declared optional Account configuration fields until OAuth succeeds', () => {
  const mode = { id: 'browser', kind: 'oauthAuthorizationCode', callbackUrl: 'https://provider.example/callback',
    pkce: 'required', outcomeReconciliation: 'providerCheck', postAuthenticationFieldIds: ['accountId'],
    configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
      { id: 'accountId', title: 'Account', schema: { type: 'string' } },
    ] } };
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse(mode).success).toBe(true);
  for (const candidate of [
    { ...mode, postAuthenticationFieldIds: ['missing'] },
    { ...mode, postAuthenticationFieldIds: ['accountId', 'accountId'] },
    { ...mode, configuration: { ...mode.configuration, scope: 'service' } },
    { ...mode, configuration: { ...mode.configuration, fields: [{ ...mode.configuration.fields[0], required: true }] } },
  ]) expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse(candidate).success).toBe(false);
});

it('binds OAuth client configuration only to distinct declared public string fields', () => {
  const mode = { id: 'browser', kind: 'oauthAuthorizationCode', callbackUrl: 'https://provider.example/callback',
    pkce: 'required', outcomeReconciliation: 'none',
    clientConfiguration: { clientIdFieldId: 'clientId', scopesFieldId: 'scopes' },
    configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
      { id: 'clientId', title: 'Client ID', schema: { type: 'string' } },
      { id: 'scopes', title: 'Scopes', schema: { type: 'string' } },
    ] } };
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse(mode).success).toBe(true);
  const semanticOrigin = { ...mode.configuration.fields[1], semantic: 'connectedAccountOrigin',
    required: true, schema: { type: 'string', minLength: 1 } };
  expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse(semanticOrigin).success).toBe(true);
  for (const candidate of [
    { ...mode, configuration: undefined },
    { ...mode, clientConfiguration: { clientIdFieldId: 'missing', scopesFieldId: 'scopes' } },
    { ...mode, clientConfiguration: { clientIdFieldId: 'clientId', scopesFieldId: 'clientId' } },
    { ...mode, configuration: { ...mode.configuration, fields: [mode.configuration.fields[0],
      { ...mode.configuration.fields[1], secret: true }] } },
    { ...mode, configuration: { ...mode.configuration, fields: [mode.configuration.fields[0],
      { ...mode.configuration.fields[1], schema: { type: 'boolean' } }] } },
    { ...mode, configuration: { ...mode.configuration, fields: [mode.configuration.fields[0], semanticOrigin] } },
    { ...mode, kind: 'manual', fields: [] },
  ]) expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse(candidate).success).toBe(false);
});

it('preserves optional Advanced configuration fields through the real UI projection', () => {
  const configuration = { scope: 'account', changeBehavior: 'reconnect', fields: [
    { id: 'accountId', title: 'Account ID', required: true, schema: { type: 'string' } },
    { id: 'clientId', title: 'Client ID', schema: { type: 'string' }, presentation: { advanced: true } },
    { id: 'registeredScopes', title: 'Scopes', schema: { type: 'string' }, presentation: { advanced: true } },
  ] };
  const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: 'deploy', title: 'Deployment account', authentication: { defaultModeId: 'browser', modes: [{
      id: 'browser', kind: 'oauthAuthorizationCode', callbackUrl: 'https://provider.example/callback',
      pkce: 'required', outcomeReconciliation: 'none', configuration,
      clientConfiguration: { clientIdFieldId: 'clientId', scopesFieldId: 'registeredScopes' },
    }] },
  });
  const projection = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
    descriptor, serviceId: 'deploy', pluginId: 'acme.deployment', provenance: 'external', sourceKind: 'installed',
    availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
  }));
  expect(projection.authentication.modes[0]?.configuration?.fields.find(field => field.id === 'clientId')?.presentation?.advanced).toBe(true);
  expect(projection.authentication.modes[0]).toMatchObject({
    clientConfiguration: { clientIdFieldId: 'clientId', scopesFieldId: 'registeredScopes' },
  });
});

it('preserves mode-owned manual setup navigation and checklist through the real UI projection', () => {
  const setup = { url: 'https://provider.example/account/tokens', checklist: [
    'Name the token Happier.',
    { key: 'token.scope', fallback: 'Select the project that this account may deploy.' },
  ], createKeyTitle: 'Create a token', billingNote: 'API usage is billed separately.',
  shapeHint: { key: 'token.shape', fallback: 'This looks like a provider token.' } };
  const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: 'deploy', title: 'Deployment account', authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', outcomeReconciliation: 'none', setup,
      fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string', minLength: 1 } }],
    }] },
  });
  const projection = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
    descriptor, serviceId: 'deploy', pluginId: 'acme.deployment', provenance: 'external', sourceKind: 'installed',
    availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
  }));
  expect(projection.authentication.modes[0]).toMatchObject({ setup });
});

it('refuses unsafe manual setup destinations and undeclared setup authority', () => {
  const mode = { id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [] };
  for (const url of ['javascript:alert(1)', 'http://provider.example/tokens', 'https://user:secret@provider.example/tokens']) {
    expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({
      ...mode, setup: { url, checklist: ['Select only the required scope.'] },
    }).success).toBe(false);
  }
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, setup: {
    url: 'https://provider.example/tokens', checklist: ['Select only the required scope.'], credentialScope: '*',
  } }).success).toBe(false);
});

it('distinguishes a declared native credential import from a new manual authentication', () => {
  const mode = { id: 'existing-login', kind: 'manual', outcomeReconciliation: 'none', fields: [], credentialOrigin: 'native_import' };
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse(mode).success).toBe(true);
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, credentialOrigin: 'authentication' }).success).toBe(true);
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, credentialOrigin: 'unknown-origin' }).success).toBe(false);
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, kind: 'oauthDeviceCode' }).success).toBe(false);
});

it('admits explicit Account-direct canonical manual fields without admitting daemon configuration or OAuth', () => {
  const mode = { id: 'key', kind: 'manual', outcomeReconciliation: 'none', accountDirectSave: true,
    fields: [{ id: 'token', title: 'Key', secret: true, schema: { type: 'string', minLength: 1 } }] };
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse(mode).success).toBe(true);
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, accountDirectSave: { fieldKeys: { token: 'apiKey' } } }).success).toBe(true);
  for (const fieldKeys of [{ unknown: 'apiKey' }, { token: '' }, { token: '__proto__' }]) {
    expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, accountDirectSave: { fieldKeys } }).success).toBe(false);
  }
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode,
    fields: [...mode.fields, { ...mode.fields[0], id: 'apiKey' }], accountDirectSave: { fieldKeys: { token: 'apiKey' } } }).success).toBe(false);
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, accountDirectSave: false }).success).toBe(false);
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, configuration: { scope: 'account', changeBehavior: 'reconnect',
    fields: [{ id: 'endpoint', title: 'Endpoint', secret: false, required: true, schema: { type: 'string' } }] } }).success).toBe(false);
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({ ...mode, kind: 'oauthDeviceCode' }).success).toBe(false);
});

it('refuses authorization-code descriptors that omit their callback URL', () => {
  const mode = { id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' };
  const descriptor = { id: 'work', title: 'Work', authentication: { defaultModeId: 'oauth', modes: [mode] } };
  expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse(mode).success).toBe(false);
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse(descriptor).success).toBe(false);
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
    ...descriptor, authentication: { ...descriptor.authentication, modes: [{ ...mode, callbackUrl: 'https://work.example/callback' }] },
  }).success).toBe(true);
});

it('admits configuration-only native account references without inventing a credential field', () => {
  const descriptor = { id: 'native', title: 'Existing native setup', authentication: {
    defaultModeId: 'native', modes: [{ id: 'native', kind: 'manual', outcomeReconciliation: 'none', fields: [],
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [{ id: 'nativeHome', title: 'Native home',
        required: true, secret: false, schema: { type: 'string', minLength: 1 } }] } }],
  } };
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse(descriptor).success).toBe(true);
});

it('admits only HTTPS provider billing destinations without embedded credentials', () => {
  const descriptor = { id: 'work', title: 'Work', authentication: { defaultModeId: 'oauth', modes: [
    { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://work.example/callback', pkce: 'required', outcomeReconciliation: 'none' },
  ] } };
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...descriptor, billingUrl: 'https://provider.test/settings/billing' }).success).toBe(true);
  for (const billingUrl of ['javascript:alert(1)', 'http://provider.test/billing', 'https://user:secret@provider.test/billing']) {
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...descriptor, billingUrl }).success).toBe(false);
  }
});

it('admits the closed native system-tool declaration without inventing a credential mode', () => {
  const descriptor = {
    id: 'work', title: 'Work',
    authentication: { defaultModeId: 'manual', native: { systemTool: 'gh' }, modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] },
  };
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse(descriptor).success).toBe(true);
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...descriptor, authentication: { ...descriptor.authentication, native: { systemTool: 'gh', token: 'secret' } } }).success).toBe(false);
});

it('admits an explicitly supported reset capability while keeping the capability envelope closed', () => {
  const descriptor = {
    id: 'work', title: 'Work',
    authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] },
    recoveryCredits: { supported: true },
  };
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse(descriptor).success).toBe(true);
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...descriptor, recoveryCredits: { supported: true, automatic: true } }).success).toBe(false);
});

it('admits provider-declared raw authorization codes only in the required-PKCE OAuth mode', () => {
  const mode = { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://work.example/callback', pkce: 'required', outcomeReconciliation: 'none', allowRawAuthorizationCode: true };
  const descriptor = { id: 'work', title: 'Work', authentication: { defaultModeId: 'oauth', modes: [mode] } };
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse(descriptor).success).toBe(true);
  for (const invalidMode of [
    { ...mode, pkce: undefined },
    { ...mode, kind: 'oauthDeviceCode' },
    { ...mode, allowRawAuthorizationCode: 'true' },
  ]) {
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      ...descriptor, authentication: { ...descriptor.authentication, modes: [invalidMode] },
    }).success).toBe(false);
  }
});

it('makes direct export an explicit manual-mode contract that OAuth modes cannot claim', () => {
  const descriptor = {
    id: 'work', title: 'Work',
    authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] },
  } as const;
  const contract = {
    contractVersion: 'happier.team-credential-manual-connected-account-direct.v1',
  } as const;
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
    ...descriptor,
    authentication: {
      defaultModeId: 'manual',
      modes: [{
        ...descriptor.authentication.modes[0],
        directExport: contract,
      }],
    },
  }).success).toBe(true);
  expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
    ...descriptor,
    authentication: {
      defaultModeId: 'oauth',
      modes: [{
        id: 'oauth',
        kind: 'oauthAuthorizationCode',
        callbackUrl: 'https://work.example/callback',
        pkce: 'required',
        outcomeReconciliation: 'providerCheck',
        directExport: contract,
      }],
    },
  }).success).toBe(false);
});

/**
 * A deployment a user picks from a closed list is routing configuration, not a
 * URL the user is asked to retype. The descriptor declares the closed choice set
 * and the exact canonical origin each choice resolves to; the host derives the
 * route from that declaration, so no free-form origin field has to stand in for
 * a fixed one.
 */
describe('connected-account fixed-origin configuration semantic', () => {
  const field = {
    id: 'region',
    title: 'Region',
    semantic: 'connectedAccountFixedOrigin',
    required: true,
    schema: { type: 'string', enum: ['us', 'de'] },
    originByValue: {
      us: 'https://us.example.test',
      de: 'https://de.example.test',
    },
  } as const;

  it('declares a closed choice set with one canonical origin per choice', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.parse(field)).toEqual({
      ...field,
      secret: false,
    });
  });

  it('refuses a choice set that does not exactly match its declared origins', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      schema: { type: 'string', enum: ['us', 'de', 'jp'] },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      originByValue: {
        ...field.originByValue,
        jp: 'https://jp.example.test',
      },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      schema: { type: 'string', minLength: 1 },
    }).success).toBe(false);
  });

  it('refuses a declared origin that is not an exact credential-free origin', () => {
    for (const declared of [
      'https://us.example.test/api',
      'https://user:secret@us.example.test',
      'ftp://us.example.test',
      'https://us.example.test/',
    ]) {
      expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
        ...field,
        originByValue: { ...field.originByValue, us: declared },
      }).success).toBe(false);
    }
  });

  it('keeps the descriptor from authoring a default or a secret route', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      default: 'us',
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      secret: true,
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      required: undefined,
    }).success).toBe(false);
  });

  it('leaves the free-form configured-origin semantic closed to a choice set', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      id: 'origin',
      title: 'Origin',
      semantic: 'connectedAccountOrigin',
      required: true,
      schema: { type: 'string', enum: ['https://us.example.test'] },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      id: 'origin',
      title: 'Origin',
      semantic: 'connectedAccountOrigin',
      required: true,
      schema: { type: 'string', minLength: 1 },
      originByValue: { us: 'https://us.example.test' },
    }).success).toBe(false);
  });
});

/**
 * A configured *service base* is a distinct declaration from an origin: it may
 * live beneath a path segment, and it is never a closed choice set.
 */
describe('connected-account service-base configuration semantic', () => {
  const field = {
    id: 'service-base',
    title: 'Service base',
    semantic: 'connectedAccountBase',
    required: true,
    schema: { type: 'string', minLength: 1 },
  } as const;

  it('declares a required non-secret free-form base', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.parse(field)).toEqual({
      ...field,
      secret: false,
    });
  });

  it('refuses a default, an optional base, and a fixed-origin route table', () => {
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      default: 'https://dev.azure.test/acme',
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      required: false,
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      originByValue: { acme: 'https://dev.azure.test' },
    }).success).toBe(false);
  });
});

it('admits an explicit organization usage identity requirement as a closed descriptor fact', () => {
  const descriptor = { id: 'work', title: 'Work', authentication: { defaultModeId: 'manual', modes: [
    { id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] },
  ] }, usageIdentity: { requiredContext: 'organization' } };
  expect(PluginConnectedAccountDescriptorContributionV2Schema.parse(descriptor)).toMatchObject({ usageIdentity: descriptor.usageIdentity });
  for (const usageIdentity of [{ requiredContext: 'account' }, { requiredContext: 'organization', fallback: true }, {}]) {
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...descriptor, usageIdentity }).success).toBe(false);
  }
});

it('admits the declared native provider identity independently of organization requirements', () => {
  const descriptor = { id: 'work', title: 'Work', authentication: { defaultModeId: 'manual', modes: [
    { id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] },
  ] }, usageIdentity: { providerId: 'openai-codex' } };
  expect(PluginConnectedAccountDescriptorContributionV2Schema.parse(descriptor)).toMatchObject({ usageIdentity: descriptor.usageIdentity });
  expect(PluginConnectedAccountDescriptorContributionV2Schema.parse({ ...descriptor,
    usageIdentity: { providerId: 'claude', requiredContext: 'organization' },
  })).toMatchObject({ usageIdentity: { providerId: 'claude', requiredContext: 'organization' } });
  for (const usageIdentity of [{ providerId: '   ' }, { providerId: 'openai-codex', selectAccount: 'other' }]) {
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...descriptor, usageIdentity }).success).toBe(false);
  }
});


it('keeps native import Machine-local while portable modes and native browser exchanges stay on the Account', () => {
  const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: 'muse-account', title: 'Muse', authentication: {
    account: { artifactId: 'connected-account-authentication', exportName: 'activate' }, defaultModeId: 'device', modes: [
      { id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none', scopes: [] },
      { id: 'api-key', kind: 'manual', apiKey: true, outcomeReconciliation: 'none', fields: [] },
      { id: 'native-import', kind: 'manual', credentialOrigin: 'native_import', outcomeReconciliation: 'none', fields: [] },
      { id: 'browser-blocked', kind: 'manual', browserReachability: 'unreachable', outcomeReconciliation: 'none', fields: [] },
    ],
  } });
  expect(descriptor.authentication.modes.map(mode => resolveConnectedAccountAuthenticationModeMachineRequirement(mode)))
    .toEqual([null, null, 'native_import', null]);
  expect(descriptor.authentication.modes.map(mode => resolveConnectedAccountAuthenticationModeMachineRequirement(mode, true)))
    .toEqual([null, null, 'native_import', 'browser_unreachable']);
  expect(descriptor.authentication.modes.map(mode => resolveConnectedAccountAuthenticationModeMachineRequirement(mode, false, 'testConnection')))
    .toEqual([null, null, null, null]);
  expect(descriptor.authentication.modes.map(mode => resolveConnectedAccountAuthenticationModeMachineRequirement(mode, true, 'testConnection')))
    .toEqual([null, null, null, 'browser_unreachable']);
});

it('admits an explicit access-only projection for OAuth and imported native subscriptions', () => {
  const accessOnlyExport = { contractVersion: 'happier.team-credential-access-only-connected-account-direct.v1',
    accessTokenKey: 'access', expiresAtMsKey: 'expiry', metadataKeys: ['mode'] };
  for (const mode of [
    { id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' },
    { id: 'native', kind: 'manual', credentialOrigin: 'native_import', fields: [], outcomeReconciliation: 'none' },
  ]) {
    const parsed = PluginConnectedAccountAuthenticationModeV2Schema.parse({ ...mode, accessOnlyExport });
    expect(parsed).toMatchObject({ accessOnlyExport });
  }
});
