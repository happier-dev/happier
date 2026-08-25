import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PluginActionContributionV2Schema,
  PluginActionExecutionV2Schema,
  PluginActionInputHintsV2Schema,
  PluginToolContributionV2Schema,
  normalizePluginActionSlashV2,
  type PluginActionInputHintsV2,
  type PluginToolContributionV2,
} from './v2.js';
import { PluginCommandContributionV2Schema } from '../contributions/v2.js';
import type { PluginLocalizedStringV2 } from '../contributions/publicTypes.js';
import {
  PluginActionExecutionV2Schema as RootPluginActionExecutionV2Schema,
  PluginActionInputHintsV2Schema as RootPluginActionInputHintsV2Schema,
  normalizePluginActionSlashV2 as RootNormalizePluginActionSlashV2,
} from '../../index.js';

const localized = { key: 'plugin.title', fallback: 'Title' };
const daemonExecution = { target: 'daemon' } as const;

describe('plugin executable contribution target grammar', () => {
  it('exposes the closed Action execution parser through the root Protocol import', () => {
    expect(RootPluginActionExecutionV2Schema).toBe(PluginActionExecutionV2Schema);
    expect(RootPluginActionExecutionV2Schema.parse({ target: 'daemon' })).toEqual({ target: 'daemon' });
  });

  it('initializes Action input hints for both direct and root Protocol imports', () => {
    expect(PluginActionInputHintsV2Schema).toBe(RootPluginActionInputHintsV2Schema);
  });

  it('exposes the Action slash normalizer through the root Protocol import', () => {
    const slash = { tokens: ['/preview', '/p'] };

    expect(RootNormalizePluginActionSlashV2).toBe(normalizePluginActionSlashV2);
    expect(RootNormalizePluginActionSlashV2(slash)).toEqual(slash);
    expect(RootNormalizePluginActionSlashV2(undefined)).toBeNull();
  });

  it('keeps each contributed Action input field title required and localized', () => {
    expectTypeOf<PluginActionInputHintsV2['fields'][number]['title']>()
      .toEqualTypeOf<PluginLocalizedStringV2>();
    expectTypeOf<NonNullable<PluginActionInputHintsV2['fields'][number]['options']>[number]['value']>()
      .toEqualTypeOf<string>();
    expectTypeOf<PluginActionInputHintsV2['fields'][number]>()
      .not.toHaveProperty('optionsSourceId');
    expectTypeOf<PluginActionInputHintsV2['fields'][number]>()
      .not.toHaveProperty('resolvedEmptyConnectedAccountOptions');
    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{ path: 'provider', widget: 'text' }],
    }).success).toBe(false);
    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        options: [],
        resolvedEmptyConnectedAccountOptions: true,
      }],
    }).success).toBe(false);
  });

  it('accepts only declared root string fields as host-stamped contextual defaults', () => {
    const action = {
      id: 'search-memory',
      title: localized,
      scopes: ['session'],
      surfaces: ['agent'],
      execution: daemonExecution,
      dangerLevel: 'safe' as const,
      inputSchema: {
        type: 'object' as const,
        properties: {
          machineId: { type: 'string' as const },
          query: { type: 'string' as const },
        },
        required: ['machineId', 'query'],
        additionalProperties: false,
      },
      contextualDefaults: {
        machineId: 'current_session_machine' as const,
      },
    };

    expect(PluginActionContributionV2Schema.parse(action).contextualDefaults).toEqual(
      action.contextualDefaults,
    );
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      contextualDefaults: { sessionId: 'current_session' },
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      contextualDefaults: { query: 'current_session_machine' },
    }).success).toBe(false);
  });

  it('keeps Tool input hints structurally static-only', () => {
    expectTypeOf<NonNullable<PluginToolContributionV2['inputHints']>['fields'][number]>()
      .not.toHaveProperty('optionsSourceId');
    expectTypeOf<NonNullable<PluginToolContributionV2['inputHints']>['fields'][number]>()
      .not.toHaveProperty('connectedAccountOptions');
  });

  it('keeps Action invocation surfaces independent from Tool surfaces and resolves the execution realm', () => {
    const daemonVoiceAction = {
      id: 'start-voice-note',
      title: localized,
      scopes: ['session'],
      surfaces: ['voice'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe' as const,
    };

    expect(PluginActionContributionV2Schema.parse(daemonVoiceAction)).toMatchObject({
      surfaces: ['voice'],
      execution: { target: 'daemon' },
    });
    const { execution: _absent, ...withoutExecution } = daemonVoiceAction;
    expect(PluginActionContributionV2Schema.safeParse(withoutExecution).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...daemonVoiceAction,
      execution: undefined,
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...daemonVoiceAction,
      execution: { target: 'host' },
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...daemonVoiceAction,
      execution: { target: 'daemon', client: { artifactId: 'a', modulePath: './a', exportName: 'a' } },
    }).success).toBe(false);
    expect(PluginToolContributionV2Schema.safeParse({
      id: 'voice-tool',
      name: 'Voice tool',
      title: localized,
      action: 'start-voice-note',
      surfaces: ['voice'],
    }).success).toBe(false);
  });

  it('accepts only a fully declared client Action execution target', () => {
    const clientAction = {
      id: 'open-client-preview',
      title: localized,
      scopes: ['session'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: {
        target: 'client',
        client: {
          artifactId: 'preview-client',
          modulePath: './previewClient',
          exportName: 'activatePreview',
        },
        platforms: ['web'],
      },
      dangerLevel: 'safe' as const,
    };

    expect(PluginActionContributionV2Schema.parse(clientAction).execution).toEqual(clientAction.execution);
    expect(PluginActionContributionV2Schema.safeParse({
      ...clientAction,
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...clientAction,
      execution: {
        ...clientAction.execution,
        platforms: ['web', 'web'],
      },
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...clientAction,
      execution: {
        ...clientAction.execution,
        client: {
          ...clientAction.execution.client,
          modulePath: '../previewClient',
        },
      },
    }).success).toBe(false);
  });

  it('admits the exact operation declaration only for daemon Actions', () => {
    const daemonAction = {
      id: 'refresh-index',
      title: localized,
      scopes: ['workspace'],
      surfaces: ['plugin'],
      execution: daemonExecution,
      dangerLevel: 'safe' as const,
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } } as const,
    };

    expect(PluginActionContributionV2Schema.parse(daemonAction).operation).toEqual(
      daemonAction.operation,
    );
    expect(PluginActionContributionV2Schema.safeParse({
      ...daemonAction,
      operation: { ...daemonAction.operation, version: 2 },
    }).success).toBe(false);
  });

  it('admits UI as an explicit action invocation surface', () => {
    expect(PluginActionContributionV2Schema.parse({
      id: 'open-preview',
      title: localized,
      scopes: ['session'],
      surfaces: ['ui'],
      execution: daemonExecution,
      placementBindings: ['detailsPanel'],
      dangerLevel: 'safe',
    }).surfaces).toEqual(['ui']);
  });

  it('keeps additive Action placement bindings distinct from generic ActionSpec placements', () => {
    const action = {
      id: 'refresh-preview',
      title: localized,
      icon: 'magic-wand',
      scopes: ['session'],
      surfaces: ['ui'],
      execution: daemonExecution,
      placementBindings: ['primary', 'secondary'],
      priority: -10,
      dangerLevel: 'safe' as const,
    };

    expect(PluginActionContributionV2Schema.parse(action)).toMatchObject({
      icon: 'magic-wand',
      placementBindings: ['primary', 'secondary'],
      priority: -10,
    });
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      placementBindings: ['primary', 'primary'],
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      placement: 'primary',
    }).success).toBe(false);
  });

  it('preserves ordered semantic Composer and message placements with icon and priority', () => {
    const action = {
      id: 'open-review',
      title: localized,
      icon: 'sparkles',
      scopes: ['session', 'message'],
      surfaces: ['ui'],
      execution: daemonExecution,
      placementBindings: [
        'composer.primary',
        'composer.more',
        'composer.slash',
        'message.menu',
      ],
      priority: -20,
      dangerLevel: 'safe' as const,
    };

    expect(PluginActionContributionV2Schema.parse(action)).toMatchObject({
      icon: 'sparkles',
      placementBindings: [
        'composer.primary',
        'composer.more',
        'composer.slash',
        'message.menu',
      ],
      priority: -20,
    });
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      placementBindings: ['composer.primary', 'composer.primary'],
    }).success).toBe(false);
  });

  it('admits bounded composer slash metadata only for UI Actions', () => {
    const action = {
      id: 'open-preview',
      title: localized,
      scopes: ['session'],
      surfaces: ['ui'],
      execution: daemonExecution,
      placementBindings: ['detailsPanel'],
      dangerLevel: 'safe' as const,
      slash: { tokens: ['/preview', '/p'] },
    };

    expect(PluginActionContributionV2Schema.parse(action).slash).toEqual({
      tokens: ['/preview', '/p'],
    });
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      surfaces: ['cli'],
      placementBindings: undefined,
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      slash: { tokens: ['preview'] },
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      slash: { tokens: ['/preview', '/preview'] },
    }).success).toBe(false);
  });

  it('admits a plugin-only Action without human-surface placement or confirmation', () => {
    expect(PluginActionContributionV2Schema.parse({
      id: 'refresh-provider-state',
      title: localized,
      scopes: ['session'],
      surfaces: ['plugin'],
      execution: daemonExecution,
      dangerLevel: 'writesRemote',
    })).toMatchObject({
      surfaces: ['plugin'],
      dangerLevel: 'writesRemote',
    });
  });

  it('requires human presentation fields only on their declared human surface', () => {
    expect(PluginActionContributionV2Schema.safeParse({
      id: 'open-without-placement',
      title: localized,
      scopes: ['session'],
      surfaces: ['ui'],
      execution: daemonExecution,
      dangerLevel: 'safe',
    }).success).toBe(false);

    expect(PluginActionContributionV2Schema.safeParse({
      id: 'write-without-confirmation',
      title: localized,
      scopes: ['session'],
      surfaces: ['plugin', 'cli'],
      execution: daemonExecution,
      dangerLevel: 'writesRemote',
    }).success).toBe(false);
  });

  it('accepts the exact action safety and confirmation contract', () => {
    expect(PluginActionContributionV2Schema.parse({
      id: 'write-summary',
      title: localized,
      scopes: ['session'],
      surfaces: ['cli', 'mcp'],
      execution: daemonExecution,
      placementBindings: ['commandPalette'],
      resultSchema: { type: 'object' },
      hostAccess: ['session-write'],
      dangerLevel: 'writesLocal',
      confirmation: {
        title: localized,
        body: 'This changes the local session.',
        confirmLabel: 'Write',
      },
    })).toMatchObject({ dangerLevel: 'writesLocal' });

    expect(PluginActionContributionV2Schema.safeParse({
      id: 'invalid-result-schema',
      title: 'Invalid result schema',
      scopes: ['session'],
      surfaces: ['cli'],
      execution: daemonExecution,
      placementBindings: ['commandPalette'],
      resultSchema: 'not-a-json-schema-object',
      dangerLevel: 'safe',
    }).success).toBe(false);

    for (const forbidden of [
      { danger: 'safe' },
      { outputSchema: { type: 'object' } },
    ]) {
      expect(PluginActionContributionV2Schema.safeParse({
        id: 'read-summary',
        title: 'Read',
        scopes: ['session'],
        surfaces: ['cli'],
        execution: daemonExecution,
        placementBindings: ['primary'],
        dangerLevel: 'safe',
        ...forbidden,
      }).success).toBe(false);
    }

    expect(PluginActionContributionV2Schema.safeParse({
      id: 'missing-confirmation',
      title: 'Write',
      scopes: ['session'],
      surfaces: ['cli'],
      execution: daemonExecution,
      placementBindings: ['primary'],
      dangerLevel: 'writesRemote',
    }).success).toBe(false);
  });

  it('admits the canonical strict input-form descriptor directly on contributed Actions', () => {
    const parsed = PluginActionContributionV2Schema.parse({
      id: 'configure-provider',
      title: localized,
      scopes: ['settings'],
      surfaces: ['ui', 'plugin'],
      execution: daemonExecution,
      placementBindings: ['detailsPanel'],
      dangerLevel: 'safe',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['provider'],
        additionalProperties: false,
      },
      inputHints: {
        title: { key: 'provider.configure.title', fallback: 'Configure provider' },
        submitLabel: { key: 'provider.configure.submit', fallback: 'Save provider' },
        fields: [{
          path: 'provider',
          title: { key: 'provider.label', fallback: 'Provider' },
          description: { key: 'provider.description', fallback: 'Choose the provider to configure.' },
          placeholder: { key: 'provider.placeholder', fallback: 'Choose a provider' },
          widget: 'select',
          options: [{ value: 'acme', label: { key: 'provider.acme', fallback: 'Acme' } }],
          visibleWhen: { op: 'truthy', path: 'enabled' },
        }, {
          path: 'enabled',
          title: { key: 'provider.enabled', fallback: 'Enabled' },
          widget: 'boolean',
        }],
      },
    });

    expect(parsed.inputHints?.fields.map((field) => field.widget)).toEqual(['select', 'boolean']);

    expect(PluginActionContributionV2Schema.safeParse({
      ...parsed,
      inputHints: {
        fields: [{
          path: 'provider',
          title: localized,
          widget: 'select',
        }],
      },
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...parsed,
      inputHints: {
        fields: [{
          path: 'provider',
          title: localized,
          widget: 'toggle',
        }],
      },
    }).success).toBe(false);
  });

  it('requires contributed form fields to resolve to declared object leaves and keeps portable options static', () => {
    const action = {
      id: 'configure-provider',
      title: localized,
      scopes: ['settings'],
      surfaces: ['ui', 'plugin'],
      execution: daemonExecution,
      placementBindings: ['detailsPanel'],
      dangerLevel: 'safe',
      inputSchema: {
        type: 'object' as const,
        properties: {
          endpoint: { type: 'string' as const },
          enabled: { type: 'boolean' as const },
        },
        additionalProperties: false,
      },
    };

    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      inputHints: {
        fields: [{ path: 'missing', title: localized, widget: 'text' }],
      },
    }).success).toBe(false);

    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      inputHints: {
        fields: [{
          path: 'endpoint',
          title: localized,
          widget: 'select',
          optionsSourceId: 'provider.endpoints.available',
        }],
      },
    }).success).toBe(false);

    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      inputSchema: { type: 'string' },
      inputHints: {
        fields: [{ path: 'endpoint', title: localized, widget: 'text' }],
      },
    }).success).toBe(false);
  });

  it('admits only the dedicated purpose-derived Connected Account field capability on exact account leaves', () => {
    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        connectedAccountOptions: true,
      }],
    }).success).toBe(true);
    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: localized,
        widget: 'multiselect',
        connectedAccountOptions: true,
      }],
    }).success).toBe(false);
    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        optionsSourceId: 'provider.endpoints.available',
      }],
    }).success).toBe(false);
    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        options: [{
          value: {
            service: { pluginId: 'com.acme.accounts', localId: 'service' },
            accountId: 'account-1',
          },
          label: localized,
        }],
      }],
    }).success).toBe(false);
    for (const field of [
      {
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        connectedAccountOptions: true,
        options: [{ value: 'legacy', label: localized }],
      },
      {
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        connectedAccountOptions: true,
        optionsSourceId: 'host.options',
      },
      {
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        connectedAccountOptions: false,
      },
    ]) {
      expect(PluginActionInputHintsV2Schema.safeParse({ fields: [field] }).success).toBe(false);
    }

    for (const field of [
      {
        path: 'credentialRef',
        title: localized,
        widget: 'select',
      },
      {
        path: 'credentialRef',
        title: localized,
        widget: 'select',
        connectedAccountOptions: true,
        options: [{ value: 'legacy', label: localized }],
      },
    ]) {
      const parsed = PluginActionInputHintsV2Schema.safeParse({ fields: [field] });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.message).join('\n'))
          .not.toContain('optionsSourceId');
      }
    }

    const action = {
      id: 'configure-account',
      title: localized,
      scopes: ['settings'],
      surfaces: ['ui'],
      execution: daemonExecution,
      placementBindings: ['detailsPanel'],
      dangerLevel: 'safe' as const,
      hostAccess: ['select-account'],
      inputHints: {
        fields: [{
          path: 'credentialRef',
          title: localized,
          widget: 'select',
          connectedAccountOptions: true,
        }],
      },
    };

    const exactRefLeaf = {
      type: 'object',
      properties: {
        service: {
          type: 'object',
          properties: {
            pluginId: { type: 'string' },
            localId: { type: 'string' },
          },
          required: ['pluginId', 'localId'],
          additionalProperties: false,
        },
        accountId: { type: 'string' },
      },
      required: ['service', 'accountId'],
      additionalProperties: false,
    };
    const withCredentialRefLeaf = (credentialRef: Record<string, unknown>) => PluginActionContributionV2Schema.safeParse({
      ...action,
      inputSchema: {
        type: 'object',
        properties: {
          credentialRef,
        },
        required: ['credentialRef'],
        additionalProperties: false,
      },
    });

    expect(withCredentialRefLeaf(exactRefLeaf).success).toBe(true);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      // A present-user core form may collect this value, but it later sends
      // it through the Channels/plugin dispatcher. The target itself remains
      // plugin-only and therefore has no UI placement or direct UI surface.
      surfaces: ['plugin'],
      placementBindings: undefined,
      inputSchema: {
        type: 'object',
        properties: { credentialRef: exactRefLeaf },
        required: ['credentialRef'],
        additionalProperties: false,
      },
    }).success).toBe(true);
    for (const credentialRef of [
      { type: 'string' },
      { ...exactRefLeaf, additionalProperties: true },
      { ...exactRefLeaf, required: ['service'] },
      { ...exactRefLeaf, required: ['service', 'accountId', 'profileId'] },
      { ...exactRefLeaf, properties: { ...exactRefLeaf.properties, profileId: { type: 'string' } } },
      {
        ...exactRefLeaf,
        properties: {
          ...exactRefLeaf.properties,
          service: {
            ...(exactRefLeaf.properties.service as Record<string, unknown>),
            additionalProperties: true,
          },
        },
      },
      {
        ...exactRefLeaf,
        properties: {
          ...exactRefLeaf.properties,
          service: {
            ...(exactRefLeaf.properties.service as Record<string, unknown>),
            properties: { plugin: { type: 'string' }, localId: { type: 'string' } },
          },
        },
      },
      { type: 'array', items: exactRefLeaf },
      { anyOf: [exactRefLeaf] },
    ]) {
      expect(withCredentialRefLeaf(credentialRef).success).toBe(false);
    }
  });

  it('requires each typed Connected Account purpose mapping to name one exact credential-ref leaf', () => {
    const credentialRef = {
      type: 'object' as const,
      properties: {
        service: {
          type: 'object' as const,
          properties: {
            pluginId: { type: 'string' as const },
            localId: { type: 'string' as const },
          },
          required: ['pluginId', 'localId'],
          additionalProperties: false,
        },
        accountId: { type: 'string' as const },
      },
      required: ['service', 'accountId'],
      additionalProperties: false,
    };
    const action = {
      id: 'use-account',
      title: localized,
      scopes: ['global'],
      surfaces: ['plugin'],
      execution: daemonExecution,
      dangerLevel: 'safe' as const,
      inputSchema: {
        type: 'object' as const,
        properties: {
          credentialRef,
          alternateCredentialRef: credentialRef,
          note: { type: 'string' as const },
        },
        required: ['credentialRef'],
        additionalProperties: false,
      },
    };

    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: 'account-use',
      }],
    }).success).toBe(true);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: 'account-use',
      }, {
        path: 'alternateCredentialRef',
        purpose: 'account-use',
      }],
    }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      connectedAccountPurposeBindings: [{
        path: 'note',
        purpose: 'account-use',
      }],
    }).success).toBe(false);
  });

  it('admits at most one Connected Account option field without limiting static Action selects', () => {
    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{
        path: 'primaryCredentialRef',
        title: localized,
        widget: 'select',
        connectedAccountOptions: true,
      }, {
        path: 'secondaryCredentialRef',
        title: localized,
        widget: 'select',
        connectedAccountOptions: true,
      }],
    }).success).toBe(false);

    expect(PluginActionInputHintsV2Schema.safeParse({
      fields: [{
        path: 'region',
        title: localized,
        widget: 'select',
        options: [{ value: 'eu', label: localized }],
      }, {
        path: 'environment',
        title: localized,
        widget: 'select',
        options: [{ value: 'production', label: localized }],
      }],
    }).success).toBe(true);
  });

  it('accepts structured tool authoring fields and rejects open legacy shapes', () => {
    expect(PluginToolContributionV2Schema.parse({
      id: 'summarize-tool',
      name: 'summarize',
      title: localized,
      action: { pluginId: 'com.acme.other', localId: 'summarize' },
      compatibility: { minimumVersion: 2, streaming: true },
      examples: { voice: { argsExample: '{"scope":"session"}' } },
      inputHints: {
        title: localized,
        fields: [{
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          options: [{ value: 'session', label: 'Session' }],
        }],
      },
    })).toMatchObject({ name: 'summarize' });

    expect(PluginToolContributionV2Schema.safeParse({
      id: 'ui-tool',
      name: 'ui_tool',
      title: 'UI tool',
      surfaces: ['ui'],
      action: 'run',
    }).success).toBe(false);

    expect(PluginToolContributionV2Schema.safeParse({
      id: 'duplicate-tool-input',
      name: 'duplicate_tool_input',
      title: 'Duplicate tool input',
      action: 'run',
      inputHints: {
        fields: [{
          path: 'scope',
          title: localized,
          widget: 'select',
          options: [{ value: 'session', label: localized }],
        }, {
          path: 'scope',
          title: localized,
          widget: 'select',
          options: [{ value: 'project', label: localized }],
        }],
      },
    }).success).toBe(false);
    expect(PluginToolContributionV2Schema.safeParse({
      id: 'plugin-tool',
      name: 'plugin_tool',
      title: 'Plugin tool',
      surfaces: ['plugin'],
      action: 'run',
    }).success).toBe(false);
    expect(PluginToolContributionV2Schema.safeParse({
      id: 'connected-account-tool',
      name: 'connected_account_tool',
      title: 'Connected Account tool',
      action: 'run',
      inputHints: {
        fields: [{
          path: 'credentialRef',
          title: localized,
          widget: 'select',
          connectedAccountOptions: true,
        }],
      },
    }).success).toBe(false);

    expect(PluginToolContributionV2Schema.safeParse({
      id: 'bad-tool',
      name: 'bad',
      title: 'Bad',
      action: 'run',
      compatibility: ['v2'],
    }).success).toBe(false);
    expect(PluginToolContributionV2Schema.safeParse({
      id: 'bad-example',
      name: 'bad_example',
      title: 'Bad',
      action: 'run',
      examples: { voice: { argsExample: '{}', extra: true } },
    }).success).toBe(false);

    for (const nonObjectSchema of [
      { type: 'string' as const },
      { type: 'array' as const, items: { type: 'string' as const } },
    ]) {
      expect(PluginToolContributionV2Schema.safeParse({
        id: 'non-object-input',
        name: 'non_object_input',
        title: 'Non-object input',
        action: 'run',
        inputSchema: nonObjectSchema,
      }).success).toBe(false);
      expect(PluginToolContributionV2Schema.safeParse({
        id: 'non-object-output',
        name: 'non_object_output',
        title: 'Non-object output',
        action: 'run',
        outputSchema: nonObjectSchema,
      }).success).toBe(false);
    }
  });

  it('keeps commands strict and limited to public visibility values', () => {
    expect(PluginCommandContributionV2Schema.parse({
      id: 'summarize-command',
      title: localized,
      path: ['summarize'],
      action: 'summarize',
      visibility: 'advanced',
      arguments: { type: 'object' },
      availability: { when: { fact: 'host.feature', operator: 'enabled', value: 'summary' } },
    })).toMatchObject({ visibility: 'advanced' });

    for (const extra of [{ visibility: 'internal' }, { command: 'bad' }]) {
      expect(PluginCommandContributionV2Schema.safeParse({
        id: 'bad-command',
        title: 'Bad',
        path: ['bad'],
        action: 'bad',
        ...extra,
      }).success).toBe(false);
    }
  });
});
