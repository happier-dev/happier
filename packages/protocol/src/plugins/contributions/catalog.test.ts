import { describe, expect, it } from 'vitest';

import {
  assertPluginProjectionFamilyIdsV2,
  derivePluginClientContributionRegistrationRights,
  derivePluginContributionRegistrationRights,
  derivePluginDaemonContributionRegistrationRights,
  listPluginProjectionFamilyIdsV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
} from './catalog.js';
import { PluginContributesV2Schema, PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 } from './v2.js';

describe('plugin contribution catalog', () => {
  it('accounts for every schema family with executable semantic metadata', () => {
    expect(PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family)).toEqual([
      'agents', 'providers', 'actions', 'commands', 'tools', 'resources', 'transcriptActivities',
      'sessionHeaderActions', 'browserTargets', 'browserActions', 'settings', 'events',
      'executionRunProfiles', 'notifications', 'notificationChannels', 'scmHostingProviders',
      'scmBackends', 'connectedAccountDescriptors', 'managedDependencies', 'systemTools',
      'promptAssets', 'hooks', 'requestInterceptors', 'voiceModelPacks', 'voiceProviders',
      'backgroundServices', 'daemonDatabases', 'composerReferences', 'composerAttachments', 'composerControls',
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
      'pluginUi',
      'pluginBrowser',
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
      expect(catalogEntry.projectJsonSchema()).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      });
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
      client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
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
          modulePath: './voiceRuntime',
          exportName: 'activate',
        },
      }],
    });
    const declaration = contributes.voiceProviders[0]!;

    expect(derivePluginClientContributionRegistrationRights(contributes, {
      artifactId: 'voice-runtime-web',
      modulePath: './voiceRuntime',
      exportName: 'activate',
      platform: 'web',
    })).toEqual([{
      family: 'voiceProviders',
      localId: 'conversation',
      target: {
        realm: 'client',
        artifactId: 'voice-runtime-web',
        modulePath: './voiceRuntime',
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
      client: { artifactId: 'voice-web', modulePath: './voice', exportName: 'activate' },
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
        client: { artifactId: 'preview-client', modulePath: './previewClient', exportName: 'activatePreview' },
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
            client: { artifactId: 'preview-client', modulePath: './previewClient', exportName: 'activatePreview' },
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
          modulePath: './previewClient',
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
      modulePath: './previewClient',
      exportName: 'activatePreview',
      platform: 'web',
    })).toEqual([{
      family: 'actions',
      localId: 'open-client-preview',
      target: {
        realm: 'client',
        artifactId: 'preview-client',
        modulePath: './previewClient',
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
      { family: 'providers', localId: 'managed', target: { realm: 'daemon' } },
      { family: 'providers', localId: 'contributed-format', target: { realm: 'daemon' } },
    ]);

    expect(derivePluginDaemonContributionRegistrationRights({
      agents: [
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
      { family: 'agents', localId: 'acp-external', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] },
      { family: 'agents', localId: 'external-only', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] },
    ]);

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
