import { describe, expect, it } from 'vitest';

import {
  assertPluginProjectionFamilyIdsV2,
  derivePluginContributionRegistrationRights,
  derivePluginDaemonContributionRegistrationRights,
  listPluginProjectionFamilyIdsV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
} from './catalog.js';
import { PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 } from './v2.js';

describe('plugin contribution catalog', () => {
  it('accounts for every schema family with executable semantic metadata', () => {
    expect(PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family)).toEqual([
      'agents', 'providers', 'actions', 'commands', 'tools', 'resources', 'structuredMessages',
      'sessionHeaderActions', 'browserTargets', 'browserActions', 'settings', 'events',
      'executionRunProfiles', 'notifications', 'notificationChannels', 'scmHostingProviders',
      'scmBackends', 'connectedAccountDescriptors', 'managedDependencies', 'systemTools',
      'promptAssets', 'hooks', 'requestInterceptors', 'voiceModelPacks', 'voiceProviders',
    ]);
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.map((entry) => entry.manifestKey)).toEqual([
      ...PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family),
      'settings.fields',
      'ui.views',
      'ui.renderers',
      'ui.translations',
      'mcp.servers',
      'mcp.discoveryProviders',
    ]);
    for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
      expect(entry).toEqual(expect.objectContaining({
        stability: expect.stringMatching(/^(stable|experimental|delegated)$/),
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
        readiness: { requirements: [] },
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
      expect.objectContaining({ stability: 'delegated', activationDemand: 'none', allowedRuntimeRegistration: null }),
    );
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'agents')).toEqual(
      expect.objectContaining({ stability: 'stable', allowedRuntimeRegistration: 'agents' }),
    );
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
    expect(entry('mcp.discoveryProviders').requiresRegistration({})).toBe(true);
  });

  it('classifies client and daemon registration realms at the canonical family catalog', () => {
    const entry = (key: string) => PLUGIN_CONTRIBUTION_CATALOG_V2.find((candidate) => candidate.manifestKey === key)!;
    expect(entry('voiceProviders').registrationHost).toBe('discriminated');
    expect(entry('voiceProviders').runtimeRegistrationHost({ kind: 'conversation' })).toBe('client');
    expect(entry('voiceProviders').runtimeRegistrationHost({ kind: 'speech' })).toBe('daemon');
    expect(entry('actions').runtimeRegistrationHost({ id: 'run' })).toBe('daemon');
    expect(entry('voiceProviders').runtimeRegistrationFamily({ kind: 'conversation' })).toBe('voiceProviders');
    expect(entry('voiceProviders').runtimeRegistrationFamily({ kind: 'speech' })).toBe('voiceProviders.speech');
    expect(entry('actions').runtimeRegistrationFamily({ id: 'run' })).toBe('actions');
    expect(entry('actions').registrationHost).toBe('daemon');
    expect(entry('agents').registrationHost).toBe('daemon');
    expect(entry('mcp.servers').registrationHost).toBe('daemon');
    expect(entry('providers').registrationHost).toBeNull();

    const contributes = {
      actions: [{ id: 'run' }],
      agents: [{ id: 'agent', runtime: { kind: 'custom' } }],
      voiceProviders: [{ id: 'conversation' }],
      mcp: { servers: [{ id: 'dynamic-server', kind: 'dynamic' }] },
    };
    expect(derivePluginContributionRegistrationRights(contributes)).toEqual([
      { family: 'agents', localId: 'agent', requiredFields: ['factory'] },
      { family: 'actions', localId: 'run' },
      { family: 'voiceProviders', localId: 'conversation' },
      { family: 'mcp.servers', localId: 'dynamic-server' },
    ]);
    expect(derivePluginDaemonContributionRegistrationRights(contributes)).toEqual([
      { family: 'agents', localId: 'agent', requiredFields: ['factory'] },
      { family: 'actions', localId: 'run' },
      { family: 'mcp.servers', localId: 'dynamic-server' },
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
      { family: 'agents', localId: 'acp-external', requiredFields: ['externalSessions'] },
      { family: 'agents', localId: 'external-only', requiredFields: ['externalSessions'] },
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
      { targetFamily: 'actions', reference: 'summarize', path: ['root', 'children', 0, 'action'] },
    ]);
    expect(entry('ui.renderers').extractReferences({
      kind: 'declarative',
      root: { kind: 'field', label: 'Name', control: { kind: 'text', settingId: 'display-name' } },
    })).toEqual([
      { targetFamily: 'settings.fields', reference: 'display-name', path: ['root', 'control', 'settingId'] },
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
});
