import { describe, expect, it } from 'vitest';

import { PluginManifestV2Schema } from '../manifest/v2.js';
import { defineProtocolObject, defineProtocolString } from '../actions/protocolComposableSchema.js';
import * as provisioners from './machineProvisioners.js';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema } from './machineProvisioners.js';

import {
  assertPluginProjectionFamilyIdsV2,
  derivePluginClientContributionRegistrationRights,
  derivePluginContributionRegistrationRights,
  derivePluginDaemonContributionRegistrationRights,
  listPluginProjectionFamilyIdsV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
} from './catalog.js';
import {
  PluginAgentRuntimeAcpV2Schema,
  PluginContributesV2Schema,
  PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2,
} from './v2.js';

describe('plugin contribution catalog', () => {
  it('admits one machine provisioner declaration and references its same-plugin daemon roles', () => {
    const roles = ['check', 'acquire', 'bootstrap', 'inspect', 'destroy', 'exec', 'put-file'];
    const native = defineProtocolObject({}, { policy: 'closed' });
    const schemas = defineMachineProvisionerSchemas({ launch: native, resource: native });
    const declaration = {
      id: 'guest', title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
      launchSchema: native.jsonSchema,
      resourceSchema: native.jsonSchema,
      platforms: ['darwin'], prerequisites: [],
      billing: { location: 'local', stoppedBilling: 'not-billed' },
      retention: { supportedIntents: ['delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
      bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
    };
    const actions = roles.map((id) => ({ id, title: id, execution: { target: 'daemon' },
      surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe',
      inputSchema: (id === 'check' ? schemas.checkInput : id === 'acquire' ? schemas.acquireInput : id === 'bootstrap' ? schemas.bootstrapInput : id === 'exec' ? schemas.execInput : id === 'put-file' ? schemas.putFileInput : schemas.resourceInput).jsonSchema,
      resultSchema: (id === 'check' ? MachineProvisionerCheckResultProtocolV1Schema : id === 'acquire' ? schemas.acquireResult : id === 'bootstrap' ? MachineProvisionerBootstrapCarrierV1Schema : id === 'inspect' ? MachineProvisionerObservationV1Schema : id === 'exec' ? MachineProvisionerNativeExecResultV1Schema : id === 'put-file' ? MachineProvisionerPutFileResultV1Schema : MachineProvisionerPowerResultV1Schema).jsonSchema,
    }));
    const parsed = PluginContributesV2Schema.safeParse({ machineProvisioners: [declaration], actions });
    expect(parsed.success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [{ ...declaration, retention: { supportedIntents: ['start'] } }], actions }).success).toBe(false);
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'machineProvisioners');
    expect(family?.extractReferences(declaration).map((reference) => reference.reference)).toEqual(roles);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [{ ...declaration,
      actions: { ...declaration.actions, acquire: { pluginId: 'other.plugin', localId: 'acquire' } },
    }], actions }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [declaration],
      actions: actions.filter((action) => action.id !== 'acquire'),
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [declaration],
      actions: actions.map(action => action.id === 'acquire' ? { ...action, inputSchema: { type: 'object', additionalProperties: false } } : action),
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [declaration],
      actions: actions.map(action => action.id === 'acquire' ? { ...action, resultSchema: { type: 'object', additionalProperties: false } } : action),
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [declaration], actions: actions.map(action => action.id === 'bootstrap' ? {
      ...action, inputSchema: { ...action.inputSchema, properties: { ...action.inputSchema.properties, credentialRef: { type: 'string' } } },
    } : action) }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [declaration], actions: actions.map(action => action.id === 'acquire' ? {
      ...action, inputSchema: { ...action.inputSchema, properties: { ...action.inputSchema.properties, unused: { type: 'string' } } },
    } : action) }).success).toBe(false);
    const handle = defineProtocolObject({ claimId: defineProtocolString() }, { policy: 'closed' });
    const reconciliation = provisioners.defineMachineProvisionerReconciliationSchemas({ launch: native, resource: native, nativeOperation: handle });
    const pendingDeclaration = { ...declaration, reconciliation: { nativeOperationSchema: handle.jsonSchema, action: 'reconcile' } };
    const pendingActions = [...actions.map(action => action.id === 'acquire' ? { ...action, resultSchema: reconciliation.result.jsonSchema }
      : action.id === 'destroy' ? { ...action, inputSchema: reconciliation.destroyInput.jsonSchema } : action),
      { ...actions[0], id: 'reconcile', inputSchema: reconciliation.input.jsonSchema, resultSchema: reconciliation.result.jsonSchema }];
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [pendingDeclaration], actions: pendingActions }).success).toBe(true);
    expect(family?.extractReferences(pendingDeclaration).map(reference => reference.reference)).toContain('reconcile');
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [pendingDeclaration], actions: actions }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [pendingDeclaration], actions: pendingActions.map(action => action.id === 'reconcile'
      ? { ...action, dangerLevel: 'writesRemote', confirmation: { title: 'Apply native change?' } } : action) }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [pendingDeclaration], actions: pendingActions.map(action => action.id === 'reconcile'
      ? { ...action, inputSchema: schemas.resourceInput.jsonSchema } : action) }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ machineProvisioners: [declaration], actions: pendingActions }).success).toBe(false);
  });
  it('treats a page column renderer as a declared renderer reference', () => {
    const entry = PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === 'ui.views')!;
    expect(entry.extractReferences({
      id: 'review', container: 'appPage', target: { kind: 'app' },
      renderer: 'page-renderer', column: { renderer: 'column-renderer' },
    })).toContainEqual({
      targetFamily: 'ui.renderers', reference: 'column-renderer', path: ['column', 'renderer'],
    });
  });
  it('admits only the strict data-only ACP definition contract', () => {
    const declarativeRuntime = {
      kind: 'acp' as const,
      transport: {
        kind: 'tcp' as const,
        host: '127.0.0.1',
        port: 4242,
      },
      definition: {
        modelConfigOptionId: 'model',
        models: {
          suffixOption: {
            id: 'reasoning_effort',
            name: 'Reasoning effort',
            values: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
            trailingOption: {
              id: 'service_tier',
              name: 'Speed',
              defaultValue: { value: 'standard', name: 'Standard' },
              values: [
                { segment: 'fast', value: 'fast', name: 'Fast' },
                { segment: 'priority', value: 'priority', name: 'Fast' },
              ],
            },
          },
        },
        stderrRules: {
          authenticationErrorDetail: 'Authenticate with the provider CLI.',
          suppress: [{
            includes: ['known harmless ACP notification'],
          }],
        },
        mcp: { policy: 'pass_through' as const },
        permissionModeMapping: {
          default: null,
          'safe-yolo': 'smart',
        },
        permissionModeArgv: {
          flag: '--approval-mode',
          map: {
            default: null,
            'safe-yolo': 'auto-edit',
          },
        },
      },
    };

    expect(PluginAgentRuntimeAcpV2Schema.parse(declarativeRuntime))
      .toEqual(declarativeRuntime);
    expect(PluginAgentRuntimeAcpV2Schema.safeParse({
      ...declarativeRuntime,
      definition: {
        ...declarativeRuntime.definition,
        callbacks: { argvBuilder: 'forbidden' },
      },
    }).success).toBe(false);
    expect(PluginAgentRuntimeAcpV2Schema.safeParse({
      ...declarativeRuntime,
      ux: { title: 'forbidden runtime presentation' },
    }).success).toBe(false);
  });

  it('keeps the shared ACP permission map as a direct reference in both raw Manifest dialects', () => {
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      const raw = PluginManifestV2Schema.toJSONSchema({ io: 'input', target, unrepresentable: 'any' });
      const definitions = raw.$defs ?? raw.definitions ?? {};
      const permissionModeArgv = Object.values(definitions).find((schema) =>
        schema.type === 'object'
        && schema.properties?.flag !== undefined
        && schema.properties?.map !== undefined
        && schema.required?.includes('flag')
        && schema.required.includes('map'));
      expect(permissionModeArgv?.properties?.map).toEqual({
        $ref: expect.stringMatching(target === 'draft-7' ? /^#\/definitions\// : /^#\/\$defs\//),
      });
    }
  });

  it('accounts for every schema family with executable semantic metadata', () => {
    expect(PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family)).toEqual([
      'agents', 'providers', 'machineProvisioners', 'actions', 'commands', 'tools', 'resources', 'inputTypes', 'dragSources', 'dropTargets', 'transcriptActivities', 'sessionInfoSections',
      'sessionHeaderActions', 'browserTargets', 'browserActions', 'settings', 'events',
      'executionRunProfiles', 'roles', 'workflows', 'notifications', 'notificationChannels', 'scmHostingProviders',
      'scmBackends', 'connectedAccountDescriptors', 'managedDependencies', 'systemTools',
      'promptAssets', 'hooks', 'requestInterceptors', 'voiceModelPacks', 'voiceProviders',
      'backgroundServices', 'captureSources', 'projectNativeAdapters', 'daemonDatabases', 'composerReferences', 'searchProviders',
      'composerAttachments', 'composerControls',
      'composerRegions', 'openableContentViewers',
      'accountCollections', 'webhooks', 'pluginContributionPoints', 'targetedPluginContributions',
    ]);
    expect(PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family)).not.toContain('structuredMessages');
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.map((entry) => entry.manifestKey)).toEqual([
      ...PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family),
      'settings.fields',
      'ui.views',
      'ui.renderers',
      'ui.settingsGroups',
      'ui.settingsPages',
      'ui.translations',
      'mcp.servers',
      'mcp.discoverySources',
    ]);
    for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
      expect(entry).toEqual(expect.objectContaining({
        activationDemand: expect.stringMatching(/^(none|declarative|registration|conditional)$/),
        references: expect.any(Array),
        consumer: expect.any(String),
        platforms: expect.any(Array),
        fixtureId: expect.any(String),
        lifecycleStages: ['declared', 'normalized', 'projected', 'bound', 'active', 'unavailable', 'invalid'],
      }));
      expect(entry).toHaveProperty('allowedRuntimeRegistration');
      expect(entry).toHaveProperty('projectionFamily');
      expect(entry).toHaveProperty('registrationHost');
      expect(entry.runtimeRegistrationHost).toEqual(expect.any(Function));
      expect(entry.runtimeRegistrationFamily).toEqual(expect.any(Function));
      expect(entry.registrationHost === null).toBe(entry.allowedRuntimeRegistration === null);
      expect(entry.canonicalize).toEqual(expect.any(Function));
      expect(entry.merge).toEqual(expect.any(Function));
      expect(entry.conflictKey).toEqual(expect.any(Function));
      expect(entry.projectIntrospection).toEqual(expect.any(Function));
      expect(entry.projectJsonSchema).toEqual(expect.any(Function));
      expect(entry.readEntries).toEqual(expect.any(Function));
    }
  });

  it('derives and closes daemon projection families from the contribution catalog', () => {
    const projectionFamilyIds = listPluginProjectionFamilyIdsV2();
    expect(projectionFamilyIds).toEqual([
      'providers',
      'machineProvisioners',
      'inputTypes',
      'dragSources',
      'dropTargets',
      'pluginUi',
      'pluginBrowser',
      'roles',
      'workflows',
      'scmHostingProviders',
      'scmBackends',
      'connectedAccounts',
      'managedDependencies',
      'voiceModelPacks',
      'voiceProviders',
      'composerAttachments',
      'composerControls',
      'composerRegions',
      'accountCollections',
      'mcp',
    ]);
    expect(() => assertPluginProjectionFamilyIdsV2(
      projectionFamilyIds,
      PLUGIN_CONTRIBUTION_CATALOG_V2.filter((entry) => entry.projectionFamily !== 'providers'),
    )).toThrow(/extra: providers/);
    expect(() => assertPluginProjectionFamilyIdsV2(
      projectionFamilyIds,
      [
        ...PLUGIN_CONTRIBUTION_CATALOG_V2,
        {
          ...PLUGIN_CONTRIBUTION_CATALOG_V2[0]!,
          manifestKey: 'fixture.projected',
          projectionFamily: 'fixtureProjection',
        },
      ],
    )).toThrow(/missing: fixtureProjection/);
  });

  it('keeps daemon database declarations static manifest facts rather than runtime registrations', () => {
    const daemonDatabases = PLUGIN_CONTRIBUTION_CATALOG_V2.find(
      (entry) => entry.manifestKey === 'daemonDatabases',
    );

    expect(daemonDatabases).toMatchObject({
      activationDemand: 'none',
      allowedRuntimeRegistration: null,
      registrationHost: null,
      consumer: 'daemon-database-service',
      platforms: ['cli', 'desktop'],
    });
  });

  it('projects an input JSON Schema for every authoritative contribution family', () => {
    for (const catalogEntry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
      try {
        expect(catalogEntry.projectJsonSchema()).toMatchObject({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
        });
      } catch (cause) {
        throw new Error(`Contribution JSON Schema projection failed for '${catalogEntry.manifestKey}'`, { cause });
      }
    }
  });

  it('carries downstream lifecycle facts without letting each family invent status vocabulary', () => {
    const actions = PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === 'actions')!;
    expect(actions.projectIntrospection({ id: 'run' }).status).toBe('normalized');
    expect(actions.projectIntrospection({ id: 'run' }, { status: 'bound' }).status).toBe('bound');
    expect(actions.projectIntrospection(
      { id: 'run' },
      { status: 'unavailable', reason: 'host_capability_missing' },
    )).toMatchObject({ status: 'unavailable', unavailableReason: 'host_capability_missing' });
  });

  it('projects contribution-specific platform support when the family declares it', () => {
    const voiceProviders = PLUGIN_CONTRIBUTION_CATALOG_V2.find(
      (candidate) => candidate.manifestKey === 'voiceProviders',
    )!;

    expect(voiceProviders.projectIntrospection({
      id: 'browser-only',
      title: 'Browser only',
      kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web'],
      capabilities: {
        turn: { cancelResponse: true, bargeIn: true },
      },
      client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
    }).platforms).toEqual(['web']);
  });

  it('owns action references and keeps model providers delegated from Agents', () => {
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'commands')?.references)
      .toContainEqual(expect.objectContaining({ field: 'action', targetFamily: 'actions' }));
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'tools')?.references)
      .toContainEqual(expect.objectContaining({ field: 'action', targetFamily: 'actions' }));
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'providers')).toEqual(
      expect.objectContaining({ activationDemand: 'conditional', allowedRuntimeRegistration: 'providers' }),
    );
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'agents')).toEqual(
      expect.objectContaining({ allowedRuntimeRegistration: 'agents' }),
    );
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'webhooks')?.references)
      .toContainEqual(expect.objectContaining({ field: 'handlerAction', targetFamily: 'actions' }));
  });

  it('derives conditional registration demand from each discriminated contribution', () => {
    const entry = (key: string) => PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === key)!;
    expect(entry('agents').requiresRegistration({ runtime: { kind: 'custom' } })).toBe(true);
    expect(entry('agents').requiresRegistration({ runtime: { kind: 'acp' } })).toBe(false);
    expect(entry('agents').requiresRegistration({
      runtime: { kind: 'acp' },
      cli: {
        auth: {
          support: 'login_terminal',
          nonInteractiveStatusProbe: true,
          loginLaunches: [{ kind: 'primary', args: ['login'] }],
        },
      },
    })).toBe(true);
    expect(entry('agents').requiresRegistration({
      runtime: { kind: 'acp' },
      capabilities: { surfaces: ['externalSessions'] },
      surfaces: { externalSession: { sources: [{}] } },
    })).toBe(true);
    expect(entry('agents').requiresRegistration({
      capabilities: { surfaces: ['externalSessions'] },
      surfaces: { externalSession: { sources: [{}] } },
    })).toBe(true);
    expect(entry('agents').requiresRegistration({
      capabilities: { surfaces: ['externalSessions'] },
    })).toBe(false);
    expect(entry('agents').requiresRegistration({
      surfaces: { externalSession: { sources: [{}] } },
    })).toBe(false);
    expect(entry('events').requiresRegistration({ kind: 'subscription' })).toBe(true);
    expect(entry('events').requiresRegistration({ kind: 'event' })).toBe(false);
    expect(entry('connectedAccountDescriptors').requiresRegistration({
      authentication: {
        defaultModeId: 'manual',
        modes: [{ id: 'manual', kind: 'manual' }],
      },
    })).toBe(true);
    expect(entry('connectedAccountDescriptors')).toEqual(expect.objectContaining({
      activationDemand: 'registration',
      allowedRuntimeRegistration: 'connectedAccounts',
    }));
    expect(entry('mcp.servers').requiresRegistration({ kind: 'static' })).toBe(false);
    expect(entry('mcp.servers').requiresRegistration({ kind: 'dynamic' })).toBe(true);
    expect(entry('mcp.discoverySources').requiresRegistration({})).toBe(true);
    expect(entry('composerAttachments').requiresRegistration({
      id: 'static-note',
      title: 'Static note',
      icon: 'note',
      cardinality: 'many',
      valueSchema: { type: 'object' },
    })).toBe(false);
    expect(entry('composerAttachments').requiresRegistration({
      id: 'prepared-note',
      title: 'Prepared note',
      icon: 'note',
      cardinality: 'many',
      valueSchema: { type: 'object' },
      runtime: { prepareForSend: true },
    })).toBe(true);
  });

  it('carries the normalized Voice declaration with each client registration right', () => {
    const contributes = PluginContributesV2Schema.parse({
      voiceProviders: [{
        id: 'conversation',
        title: 'Conversation',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web'],
        capabilities: {
          turn: { cancelResponse: true, bargeIn: false },
        },
        client: {
          artifactId: 'voice-runtime-web',
          exportName: 'activate',
        },
      }],
    });
    const declaration = contributes.voiceProviders[0]!;

    expect(derivePluginClientContributionRegistrationRights(contributes, {
      artifactId: 'voice-runtime-web',
      exportName: 'activate',
      platform: 'web',
    })).toEqual([{
      family: 'voiceProviders',
      localId: 'conversation',
      target: {
        realm: 'client',
        artifactId: 'voice-runtime-web',
        exportName: 'activate',
        platforms: ['web'],
      },
      voiceProviderDeclaration: declaration,
    }]);
  });

  it('classifies client and daemon registration realms at the canonical family catalog', () => {
    const entry = (key: string) => PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === key)!;
    expect(entry('voiceProviders').registrationHost).toBe('discriminated');
    expect(entry('voiceProviders').runtimeRegistrationHost({
      kind: 'conversation',
      client: { artifactId: 'voice-web', exportName: 'activate' },
      platforms: ['web'],
    })).toBe('client');
    expect(entry('voiceProviders').runtimeRegistrationHost({ kind: 'speech' })).toBe('daemon');
    expect(entry('actions').runtimeRegistrationHost({
      id: 'run',
      execution: { target: 'daemon' },
    })).toBe('daemon');
    expect(entry('actions').runtimeRegistrationHost({
      id: 'open-client-preview',
      execution: {
        target: 'client',
        client: { artifactId: 'preview-client', exportName: 'activatePreview' },
        platforms: ['web'],
      },
    })).toBe('client');
    expect(entry('voiceProviders').runtimeRegistrationFamily({ kind: 'conversation' })).toBe('voiceProviders');
    expect(entry('voiceProviders').runtimeRegistrationFamily({ kind: 'speech' })).toBe('voiceProviders');
    expect(entry('actions').runtimeRegistrationFamily({ id: 'run' })).toBe('actions');
    expect(entry('actions').registrationHost).toBe('discriminated');
    expect(entry('agents').registrationHost).toBe('daemon');
    expect(entry('mcp.servers').registrationHost).toBe('daemon');
    expect(entry('providers').registrationHost).toBe('daemon');
    expect(entry('composerAttachments').registrationHost).toBe('daemon');

    const contributes = {
      actions: [
        { id: 'run', execution: { target: 'daemon' } },
        {
          id: 'open-client-preview',
          execution: {
            target: 'client',
            client: { artifactId: 'preview-client', exportName: 'activatePreview' },
            platforms: ['web'],
          },
        },
      ],
      agents: [{ id: 'agent', runtime: { kind: 'custom' } }],
      mcp: { servers: [{ id: 'dynamic-server', kind: 'dynamic' }] },
    };
    expect(derivePluginContributionRegistrationRights(contributes)).toEqual([
      { family: 'agents', localId: 'agent', target: { realm: 'daemon' }, requiredFields: ['factory'] },
      { family: 'actions', localId: 'run', target: { realm: 'daemon' } },
      {
        family: 'actions',
        localId: 'open-client-preview',
        target: {
          realm: 'client',
          artifactId: 'preview-client',
          exportName: 'activatePreview',
          platforms: ['web'],
        },
      },
      { family: 'mcp.servers', localId: 'dynamic-server', target: { realm: 'daemon' } },
    ]);
    expect(derivePluginDaemonContributionRegistrationRights(contributes)).toEqual([
      { family: 'agents', localId: 'agent', target: { realm: 'daemon' }, requiredFields: ['factory'] },
      { family: 'actions', localId: 'run', target: { realm: 'daemon' } },
      { family: 'mcp.servers', localId: 'dynamic-server', target: { realm: 'daemon' } },
    ]);
    expect(derivePluginClientContributionRegistrationRights(contributes, {
      artifactId: 'preview-client',
      exportName: 'activatePreview',
      platform: 'web',
    })).toEqual([{
      family: 'actions',
      localId: 'open-client-preview',
      target: {
        realm: 'client',
        artifactId: 'preview-client',
        exportName: 'activatePreview',
        platforms: ['web'],
      },
    }]);

    expect(derivePluginDaemonContributionRegistrationRights({
      providers: [
        { id: 'ordinary' },
        { id: 'managed', managedRuntime: { kind: 'managed' } },
        {
          id: 'bundled-format',
          catalog: { source: 'probe', probes: [{ parser: 'openai-models' }] },
        },
        {
          id: 'contributed-format',
          catalog: { source: 'probe', probes: [{ parser: 'acme-catalog-v3' }] },
        },
      ],
    })).toEqual([
      {
        family: 'providers',
        localId: 'managed',
        target: { realm: 'daemon' },
        providerArms: { managedRuntime: true, catalogParserIds: [] },
      },
      {
        family: 'providers',
        localId: 'contributed-format',
        target: { realm: 'daemon' },
        providerArms: { managedRuntime: false, catalogParserIds: ['acme-catalog-v3'] },
      },
    ]);

    // A Provider declaring BOTH arms must carry BOTH in its registration right,
    // so activation can refuse a plugin that implements only one of them.
    expect(derivePluginDaemonContributionRegistrationRights({
      providers: [{
        id: 'dual',
        managedRuntime: { kind: 'managed' },
        catalog: { source: 'probe', probes: [{ parser: 'acme-catalog-v3' }, { parser: 'openai-models' }] },
        discovery: { catalogFallback: { parser: 'acme-command-v1' } },
      }],
    })).toEqual([{
      family: 'providers',
      localId: 'dual',
      target: { realm: 'daemon' },
      providerArms: {
        managedRuntime: true,
        catalogParserIds: ['acme-catalog-v3', 'acme-command-v1'],
      },
    }]);

    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [
        {
          id: 'acp-terminal',
          runtime: { kind: 'acp' },
          capabilities: { surfaces: ['terminal'] },
        },
        {
          id: 'acp-external',
          runtime: { kind: 'acp' },
          capabilities: { surfaces: ['externalSessions'] },
          surfaces: { externalSession: { sources: [{}] } },
        },
        {
          id: 'external-only',
          capabilities: { surfaces: ['externalSessions'] },
          surfaces: { externalSession: { sources: [{}] } },
        },
      ],
    })).toEqual([
      { family: 'agents', localId: 'acp-terminal', target: { realm: 'daemon' }, requiredFields: ['terminal'] },
      { family: 'agents', localId: 'acp-external', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] },
      { family: 'agents', localId: 'external-only', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] },
    ]);

    // A `custom` runtime owns its terminal inside the Agent runtime it returns
    // (`AgentRuntime.surfaces.terminal`), and the runtime lease rejects an
    // Agent that carries both that surface and a registered contribution. The
    // terminal capability therefore demands a registered contribution only for
    // host-owned runtimes.
    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [
        {
          id: 'custom-terminal',
          runtime: { kind: 'custom' },
          capabilities: {
            surfaces: ['terminal'],
            sessions: { open: ['create'], delivery: ['newTurn'] },
          },
        },
      ],
    })).toEqual([
      {
        family: 'agents',
        localId: 'custom-terminal',
        target: { realm: 'daemon' },
        requiredFields: ['factory', 'sessionRunnerFactory'],
      },
    ]);

    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [{
        id: 'acp-auth-probe',
        runtime: { kind: 'acp' },
        cli: {
          auth: {
            support: 'login_terminal',
            nonInteractiveStatusProbe: true,
            loginLaunches: [{ kind: 'primary', args: ['login'] }],
          },
        },
      }],
    })).toEqual([{
      family: 'agents',
      localId: 'acp-auth-probe',
      target: { realm: 'daemon' },
      requiredFields: ['cliAuth'],
    }]);

    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [{
        id: 'custom-external',
        runtime: { kind: 'custom' },
        capabilities: { surfaces: ['externalSessions'] },
        surfaces: { externalSession: { sources: [{}] } },
      }],
    })).toEqual([{
      family: 'agents',
      localId: 'custom-external',
      target: { realm: 'daemon' },
      requiredFields: ['factory', 'externalSessions'],
    }]);

    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [
        { id: 'undeclared', runtime: { kind: 'acp' } },
        { id: 'capability-only', capabilities: { surfaces: ['externalSessions'] } },
        { id: 'descriptor-only', surfaces: { externalSession: { sources: [{}] } } },
      ],
    })).toEqual([]);
  });

  it('exempts only a valid all-resume-only ACP declaration from the External Sessions contribution', () => {
    // The host synthesizes exactly one generic ACP `session/list` producer for
    // a valid all-resume-only declaration, so demanding a plugin contribution
    // there rejects the declaration the host itself serves, and accepting one
    // would install a competing owner. Every weaker shape below keeps owing the
    // contribution and stays fail-closed.
    const source = (extra: Readonly<Record<string, unknown>> = {}) => ({
      sourceKind: 'acpSessions',
      schema: { fields: [{ name: 'kind', kind: 'literal', value: 'acpSessions' }] },
      key: { segments: [{ kind: 'literal', value: 'acpSessions' }] },
      ...extra,
    });
    const resumeOnlyAgent = (
      id: string,
      overrides: Readonly<Record<string, unknown>> = {},
    ) => ({
      id,
      runtime: { kind: 'acp' },
      primary: 'sessions',
      capabilities: {
        surfaces: ['externalSessions'],
        sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
      },
      surfaces: { externalSession: { sources: [source({ resumeOnly: true })] } },
      ...overrides,
    });

    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [
        // The FX/Kimi shape: the plugin still owes its terminal contribution
        // and nothing for External Sessions.
        resumeOnlyAgent('resume-only-terminal', {
          capabilities: {
            surfaces: ['terminal', 'externalSessions'],
            sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
          },
        }),
        // One non-resume-only source is one source the host cannot produce.
        resumeOnlyAgent('mixed-sources', {
          surfaces: {
            externalSession: { sources: [source({ resumeOnly: true }), source()] },
          },
        }),
        // Ordinary (no resume-only source at all).
        resumeOnlyAgent('ordinary-sources', {
          surfaces: { externalSession: { sources: [source()] } },
        }),
        // Resume-only without an explicitly open `resume` route cannot be
        // fulfilled, so the host synthesizes nothing and the plugin still owes
        // the contribution.
        resumeOnlyAgent('resume-only-without-resume-capability', {
          capabilities: {
            surfaces: ['externalSessions'],
            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
          },
        }),
        // Only the declarative ACP runtime has a host-owned session listing.
        resumeOnlyAgent('custom-runtime-resume-only', { runtime: { kind: 'custom' } }),
      ],
    })).toEqual([
      { family: 'agents', localId: 'resume-only-terminal', target: { realm: 'daemon' }, requiredFields: ['terminal'] },
      { family: 'agents', localId: 'mixed-sources', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] },
      { family: 'agents', localId: 'ordinary-sources', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] },
      {
        family: 'agents',
        localId: 'resume-only-without-resume-capability',
        target: { realm: 'daemon' },
        requiredFields: ['externalSessions'],
      },
      {
        family: 'agents',
        localId: 'custom-runtime-resume-only',
        target: { realm: 'daemon' },
        requiredFields: ['factory', 'sessionRunnerFactory', 'externalSessions'],
      },
    ]);

    // A host-synthesized declaration with no other plugin-owned facet demands
    // no daemon registration at all.
    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [resumeOnlyAgent('resume-only-alone')],
    })).toEqual([]);
  });

  it('derives one exact attachment registration right only for declared runtime roles', () => {
    const pure = derivePluginDaemonContributionRegistrationRights({
      composerAttachments: [{
        id: 'static-note',
        title: 'Static note',
        icon: 'note',
        cardinality: 'many',
        valueSchema: { type: 'object' },
      }],
    });
    const runtime = derivePluginDaemonContributionRegistrationRights({
      composerAttachments: [{
        id: 'prepared-note',
        title: 'Prepared note',
        icon: 'note',
        cardinality: 'many',
        valueSchema: { type: 'object' },
        runtime: { prepareForSend: true, afterMessageAccepted: true },
      }],
    });

    expect(pure).toEqual([]);
    expect(runtime).toEqual([{
      family: 'composerAttachments',
      localId: 'prepared-note',
      target: { realm: 'daemon' },
      requiredFields: ['prepareForSend', 'afterMessageAccepted'],
    }]);
  });

  it('applies each identified family conflict rule without misreporting delegated ids as local ids', () => {
    const entry = (key: string) => PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === key)!;
    expect(entry('settings.fields').conflictKey({ id: 'endpoint' })).toBe('endpoint');
    expect(entry('settings.fields').merge({ id: 'endpoint' }, { id: 'endpoint' })).toEqual({
      ok: false,
      code: 'plugin_contribution_conflict',
    });
    expect(entry('ui.translations').conflictKey({ locale: 'en' })).toBe('en');
    expect(entry('providers').conflictKey({ id: 'gateway' })).toBe('gateway');
    expect(entry('providers').projectIntrospection({ id: 'gateway' })).toMatchObject({ localId: null });
  });

  it('extracts nested references with their exact owning paths', () => {
    const entry = (key: string) => PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === key)!;
    expect(entry('ui.renderers').extractReferences({
      kind: 'declarative',
      root: { kind: 'action', hostAction: 'session.message.send', label: 'Send' },
    })).toEqual([]);
    expect(entry('promptAssets').extractReferences({ resource: 'prompt', target: { kind: 'agent', agent: 'agent' } })).toEqual([
      { targetFamily: 'resources', reference: 'prompt', path: ['resource'] },
      { targetFamily: 'agents', reference: 'agent', path: ['target', 'agent'] },
    ]);
    expect(entry('settings').extractReferences({ target: { kind: 'agent', agent: { pluginId: 'com.acme.agent', localId: 'agent' } } })).toEqual([
      { targetFamily: 'agents', reference: { pluginId: 'com.acme.agent', localId: 'agent' }, path: ['target', 'agent'] },
    ]);
    expect(entry('mcp.servers').extractReferences({
      transport: { kind: 'stdio', executable: { kind: 'managedDependency', id: 'acme-cli' } },
    })).toEqual([
      { targetFamily: 'managedDependencies', reference: 'acme-cli', path: ['transport', 'executable', 'id'] },
    ]);
    expect(entry('ui.renderers').extractReferences({
      kind: 'declarative',
      root: { kind: 'stack', children: [{ kind: 'action', action: 'summarize' }] },
    })).toEqual([
      {
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        reference: 'summarize',
        path: ['root', 'children', 0, 'action'],
      },
    ]);
    expect(entry('ui.renderers').extractReferences({
      kind: 'declarative',
      root: { kind: 'field', label: 'Name', control: { kind: 'text', settingId: 'display-name' } },
    })).toEqual([
      { targetFamily: 'settings.fields', reference: 'display-name', path: ['root', 'control', 'settingId'] },
    ]);
    expect(entry('ui.renderers').extractReferences({
      kind: 'declarative',
      root: { kind: 'text', text: 'Static first paint' },
      documentSource: { kind: 'resource', resourceId: 'live-document' },
    })).toEqual([
      { targetFamily: 'resources', reference: 'live-document', path: ['documentSource', 'resourceId'] },
    ]);
    expect(entry('ui.renderers').extractReferences({
      kind: 'declarative',
      root: {
        kind: 'stack',
        children: [{
          kind: 'item',
          title: 'Open task',
          action: 'open-item',
        }, {
          kind: 'collectionList',
          source: { collectionId: 'tasks', uiQueryId: 'open-tasks' },
          projection: { titleField: { field: 'title', kind: 'string' } },
          primaryCommand: { kind: 'action', action: 'open-primary' },
          secondaryCommands: [
            { kind: 'action', action: 'open-secondary' },
            { kind: 'openSurface', destination: { pluginId: 'com.acme.provider', localId: 'task-details' } },
          ],
        }],
      },
    })).toEqual([
      {
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        reference: 'open-primary',
        path: ['root', 'children', 1, 'primaryCommand', 'action'],
      },
      {
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        reference: 'open-secondary',
        path: ['root', 'children', 1, 'secondaryCommands', 0, 'action'],
      },
      {
        targetFamily: 'ui.views',
        targetFamilies: ['ui.views', 'ui.settingsPages'],
        allowQualifiedCrossPlugin: true,
        reference: { pluginId: 'com.acme.provider', localId: 'task-details' },
        path: ['root', 'children', 1, 'secondaryCommands', 1, 'destination'],
      },
      {
        targetFamily: 'actions',
        allowQualifiedCrossPlugin: false,
        reference: 'open-item',
        path: ['root', 'children', 0, 'action'],
      },
    ]);
    expect(entry('agents').extractReferences({
      runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'acme-cli' } } },
    })).toEqual([
      { targetFamily: 'systemTools', reference: 'acme-cli', path: ['runtime', 'transport', 'executable', 'id'] },
    ]);
    expect(entry('voiceProviders').references).toEqual([]);
    expect(entry('voiceProviders').extractReferences({
      client: { artifactId: 'voice-runtime-web' },
      accountMediation: { operations: [{ id: 'auth', purpose: 'client_auth' }] },
    })).toEqual([
      { targetFamily: 'generated.uiArtifacts', reference: 'voice-runtime-web', path: ['client', 'artifactId'] },
    ]);
  });

  it('does not create attachment reference edges from held composer-control state', () => {
    const entry = PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === 'composerControls')!;

    expect(entry.extractReferences({
      state: {
        attachmentSelection: {
          attachments: ['issue'],
          one: 'selectedLabel',
          many: 'count',
          icon: 'selectedIcon',
        },
      },
      interaction: { kind: 'action', action: 'refresh-issue' },
    })).toEqual([
      { targetFamily: 'actions', allowQualifiedCrossPlugin: false, reference: 'refresh-issue', path: ['interaction', 'action'] },
    ]);
  });

  it('extracts every active Composer renderer, state, action, and attachment edge through the one catalog owner', () => {
    const entry = (key: string) => PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === key)!;

    expect(entry('composerAttachments').extractReferences({
      picker: { renderer: 'issue-picker', fallbackRenderers: ['issue-picker-fallback'] },
      display: { kind: 'surface', renderer: { renderer: 'issue-display' } },
      preview: { kind: 'surface', renderer: { renderer: 'issue-preview' } },
    })).toEqual([
      { targetFamily: 'ui.renderers', reference: 'issue-picker', path: ['picker', 'renderer'] },
      { targetFamily: 'ui.renderers', reference: 'issue-picker-fallback', path: ['picker', 'fallbackRenderers', 0] },
      { targetFamily: 'ui.renderers', reference: 'issue-display', path: ['display', 'renderer', 'renderer'] },
      { targetFamily: 'ui.renderers', reference: 'issue-preview', path: ['preview', 'renderer', 'renderer'] },
    ]);

    expect(entry('composerControls').extractReferences({
      state: { resource: 'issue-control-state' },
      compactRenderer: { renderer: 'issue-compact' },
      interaction: {
        kind: 'choices',
        options: [
          { effect: { kind: 'action', action: 'refresh-issue' } },
          {
            effect: {
              kind: 'composerApply',
              operations: [
                { kind: 'attachment.add', attachmentLocalId: 'issue' },
                { kind: 'attachment.remove', instanceId: 'instance-1' },
              ],
            },
          },
        ],
      },
    })).toEqual([
      { targetFamily: 'resources', allowQualifiedCrossPlugin: false, reference: 'issue-control-state', path: ['state', 'resource'] },
      { targetFamily: 'ui.renderers', reference: 'issue-compact', path: ['compactRenderer', 'renderer'] },
      { targetFamily: 'actions', allowQualifiedCrossPlugin: false, reference: 'refresh-issue', path: ['interaction', 'options', 0, 'effect', 'action'] },
      { targetFamily: 'composerAttachments', allowQualifiedCrossPlugin: false, reference: 'issue', path: ['interaction', 'options', 1, 'effect', 'operations', 0, 'attachmentLocalId'] },
    ]);

    expect(entry('composerRegions').extractReferences({
      renderer: { renderer: 'warning-region', fallbackRenderers: ['warning-region-fallback'] },
    })).toEqual([
      { targetFamily: 'ui.renderers', reference: 'warning-region', path: ['renderer', 'renderer'] },
      { targetFamily: 'ui.renderers', reference: 'warning-region-fallback', path: ['renderer', 'fallbackRenderers', 0] },
    ]);
  });
});
