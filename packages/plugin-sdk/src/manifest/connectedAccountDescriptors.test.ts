import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PluginConnectedAccountConfigurationFieldV2Schema,
  PluginConnectedAccountDescriptorContributionV2Schema,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginConnectedAccountConfigurationFieldV2,
} from './connectedAccountDescriptors.js';

describe('plugin SDK connected account descriptor manifest surface', () => {
  it('retains every declared authentication mode and its configuration contract', () => {
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: 'example-connected-account',
      title: {
        key: 'plugins.example.connectedAccount.title',
        fallback: 'Example account',
      },
      authentication: {
        defaultModeId: 'device',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Personal access token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }, {
            id: 'username',
            title: 'Username',
            schema: { type: 'string', minLength: 1 },
          }],
        }, {
          id: 'authorization-code',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'https://provider.example/oauth/callback',
          pkce: 'required',
          outcomeReconciliation: 'providerCheck',
          scopes: ['repository.read'],
          configuration: {
            scope: 'service',
            changeBehavior: 'reconnect',
            fields: [{
              id: 'baseUrl',
              title: 'Base URL',
              schema: { type: 'string', minLength: 1 },
              default: 'https://example.test',
              presentation: { control: 'text' },
            }],
          },
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          outcomeReconciliation: 'lateEvidence',
          scopes: ['repository.read'],
        }],
      },
      capabilities: ['repository.read'],
    });

    expect(descriptor.id).toBe('example-connected-account');
    expect(descriptor.authentication.defaultModeId).toBe('device');
    expect(descriptor.authentication.modes.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'manual', kind: 'manual' },
      { id: 'authorization-code', kind: 'oauthAuthorizationCode' },
      { id: 'device', kind: 'oauthDeviceCode' },
    ]);
    expect(descriptor.authentication.modes[0]).toMatchObject({
      fields: [
        { id: 'token', secret: true },
        { id: 'username', secret: false },
      ],
    });
    expect(descriptor.authentication.modes[1]).toMatchObject({
      callbackUrl: 'https://provider.example/oauth/callback',
      outcomeReconciliation: 'providerCheck',
      configuration: {
        scope: 'service',
        changeBehavior: 'reconnect',
        fields: [{
          id: 'baseUrl',
          schema: { type: 'string', minLength: 1 },
          secret: false,
          default: 'https://example.test',
        }],
      },
    });
  });

  it('rejects malformed provider-fixed OAuth callback URLs', () => {
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      id: 'example-connected-account',
      title: 'Example account',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'not-a-url',
          pkce: 'required',
          outcomeReconciliation: 'none',
        }],
      },
    }).success).toBe(false);
  });

  it('requires a unique declared default mode and rejects settings-only configuration bindings', () => {
    const base = {
      id: 'example-connected-account',
      title: 'Example account',
      authentication: {
        defaultModeId: 'device',
        modes: [{
          id: 'device',
          kind: 'oauthDeviceCode',
          outcomeReconciliation: 'none',
        }],
      },
    };

    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      ...base,
      authentication: { ...base.authentication, defaultModeId: 'missing' },
    }).success).toBe(false);
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      ...base,
      authentication: {
        defaultModeId: 'device',
        modes: [...base.authentication.modes, { ...base.authentication.modes[0] }],
      },
    }).success).toBe(false);
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      ...base,
      authentication: {
        defaultModeId: 'device',
        modes: [{
          ...base.authentication.modes[0],
          configuration: {
            scope: 'service',
            changeBehavior: 'refresh',
            fields: [{
              id: 'baseUrl',
              title: 'Base URL',
              schema: { type: 'string' },
              presentation: {
                binding: { kind: 'direct', settingId: 'otherSetting' },
              },
            }],
          },
        }],
      },
    }).success).toBe(false);
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      ...base,
      hostAdapter: 'githubOAuth',
    }).success).toBe(false);

    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      ...base,
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'duplicate',
            title: 'First',
            schema: { type: 'string' },
          }, {
            id: 'duplicate',
            title: 'Second',
            schema: { type: 'string' },
          }],
        }],
      },
    }).success).toBe(false);

    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({
      ...base,
      authentication: {
        defaultModeId: 'device',
        modes: [{
          ...base.authentication.modes[0],
          configuration: {
            scope: 'account',
            changeBehavior: 'refresh',
            fields: [{
              id: 'duplicate',
              title: 'First',
              schema: { type: 'string' },
            }, {
              id: 'duplicate',
              title: 'Second',
              schema: { type: 'string' },
            }],
          },
        }],
      },
    }).success).toBe(false);
  });

  it('projects a configured-origin semantic without granting or declaring an origin', () => {
    expectTypeOf<PluginConnectedAccountConfigurationFieldV2['semantic']>()
      .toEqualTypeOf<
        | 'connectedAccountOrigin'
        | 'connectedAccountFixedOrigin'
        | 'connectedAccountBase'
        | undefined
      >();
    type ConnectedAccountOriginField = Extract<
      PluginConnectedAccountConfigurationFieldV2,
      { semantic: 'connectedAccountOrigin' }
    >;
    expectTypeOf<ConnectedAccountOriginField>().not.toBeNever();
    expectTypeOf<ConnectedAccountOriginField['required']>().toEqualTypeOf<true>();
    expectTypeOf<ConnectedAccountOriginField['secret']>().toEqualTypeOf<false>();
    expectTypeOf<ConnectedAccountOriginField['default']>().toEqualTypeOf<undefined>();
    expectTypeOf<ConnectedAccountOriginField['schema']['type']>().toEqualTypeOf<'string'>();
    expectTypeOf<
      Extract<PluginConnectedAccountAuthenticationModeV2, { kind: 'manual' }>['configuration']
    >().toMatchTypeOf<{ scope: 'service' | 'account' } | undefined>();

    const field = {
      id: 'api-origin',
      title: 'API origin',
      semantic: 'connectedAccountOrigin',
      required: true,
      schema: { type: 'string', minLength: 1 },
      presentation: { control: 'text', placeholder: 'https://api.example.com' },
    } as const;
    expect(PluginConnectedAccountConfigurationFieldV2Schema.parse(field)).toEqual({
      ...field,
      secret: false,
    });
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: 'novel-cloud',
      title: 'Novel Cloud',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Token',
            secret: true,
            schema: { type: 'string', minLength: 1 },
          }],
          configuration: {
            scope: 'service',
            changeBehavior: 'reconnect',
            fields: [field],
          },
        }],
      },
    });
    expect(descriptor.authentication.modes[0]).toMatchObject({
      kind: 'manual',
      fields: [{ id: 'token', secret: true }],
      configuration: {
        scope: 'service',
        changeBehavior: 'reconnect',
        fields: [{
          id: 'api-origin',
          semantic: 'connectedAccountOrigin',
          secret: false,
          required: true,
        }],
      },
    });

    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      secret: true,
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      schema: { type: 'number' },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      default: 'https://descriptor-authored.example.com',
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      required: undefined,
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      schema: {
        type: 'string',
        enum: ['https://descriptor-authored.example.com'],
      },
    }).success).toBe(false);
    expect(PluginConnectedAccountConfigurationFieldV2Schema.safeParse({
      ...field,
      origin: 'https://descriptor-authored.example.com',
      hostAccessId: 'producer-network',
    }).success).toBe(false);
  });
});
