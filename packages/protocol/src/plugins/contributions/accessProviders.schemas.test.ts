import { describe, expect, it } from 'vitest';
import { PluginContributesV2Schema } from './v2.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from './catalog.js';
import { AccessProviderContributionV1Schema, AccessProviderSelectionV1Schema, defineAccessProviderSchemas } from './accessProviders.js';
import { createProtocolComposableSchema, defineProtocolObject, defineProtocolString } from '../actions/protocolComposableSchema.js';
import { ingestPluginManifestV2 } from '../manifest/ingest.js';

describe('access provider contribution admission', () => {
  it('admits non-secret configuration names while preserving recursive closure', () => {
    const descriptor = {
      id: 'network', title: 'Network', icon: 'network', schemaVersion: 1,
      targets: ['machine'], capabilities: ['management'], exposure: 'privateNetwork',
      inboundPorts: [], credentialPurposes: [{ purpose: 'network.join', required: true }], actions: { inspect: 'inspect' },
    };
    const configuration = (field: string) => ({ type: 'object', additionalProperties: false,
      properties: { native: { type: 'object', additionalProperties: false, properties: { [field]: { type: 'string' } } } } });
    expect(AccessProviderContributionV1Schema.safeParse({ ...descriptor, configSchema: configuration('tokenCount') }).success).toBe(true);
    // A diagnostic-key classifier cannot infer whether a plugin-owned value
    // is a credential. This is a non-secret policy label, not a secret fill.
    expect(AccessProviderContributionV1Schema.safeParse({ ...descriptor, configSchema: {
      type: 'object', additionalProperties: false, properties: {
        passwordPolicy: { type: 'string', enum: ['standard', 'strict'] },
      },
    } }).success).toBe(true);
    expect(AccessProviderContributionV1Schema.safeParse({ ...descriptor, configSchema: {
      type: 'object', additionalProperties: false,
      properties: { native: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } },
    } }).success).toBe(false);
  });
  it('admits exact daemon contracts, rejects unsafe inspection and closes nested role inputs', () => {
    const config = defineProtocolObject({ managementUrl: defineProtocolString() }, { policy: 'closed' });
    const roles = defineAccessProviderSchemas({ config });
    const descriptor = {
      id: 'network', title: 'Network', icon: 'network', schemaVersion: 1,
      targets: ['machine'], capabilities: ['privateNetwork'], exposure: 'privateNetwork',
      configSchema: config.jsonSchema, inboundPorts: [], credentialPurposes: [],
      actions: { inspect: 'inspect', join: 'join', leave: 'leave' },
    };
    const actions = (['inspect', 'join', 'leave'] as const).map(role => ({
      id: role, title: role, scopes: ['machine'], surfaces: ['plugin'], execution: { target: 'daemon' },
      dangerLevel: role === 'inspect' ? 'safe' : 'externalSideEffect',
      inputSchema: roles[`${role}Input`].jsonSchema, resultSchema: roles.result.jsonSchema,
    }));
    expect(PluginContributesV2Schema.safeParse({ accessProviders: [descriptor], actions }).success).toBe(true);
    const referencedConfig = createProtocolComposableSchema({
      $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
      $defs: { mode: { type: 'string', enum: ['private'] } },
      properties: { mode: { $ref: '#/$defs/mode' } }, required: ['mode'],
    });
    const referencedRoles = defineAccessProviderSchemas({ config: referencedConfig });
    expect(PluginContributesV2Schema.safeParse({ accessProviders: [{ ...descriptor, configSchema: referencedConfig.jsonSchema }],
      actions: actions.map(action => ({ ...action, inputSchema: referencedRoles[`${action.id}Input`].jsonSchema })),
    }).success).toBe(true);
    const manifest = (install: unknown, systemTools: unknown[] = []) => ({
      schemaVersion: 2, id: 'example.network', version: '1.0.0', displayName: 'Network',
      runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' },
      contributes: { accessProviders: [{ ...descriptor, install }], actions, systemTools },
    });
    expect(ingestPluginManifestV2(manifest({ kind: 'systemTool', id: 'network-cli' })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ kind: 'systemTool', id: 'network-cli' }, [
      { id: 'network-cli', title: 'Network CLI', executableNames: ['network-cli'] },
    ])).ok).toBe(true);
    const recipeManifest = manifest({ kind: 'recipe', ref: { pluginId: 'example.network', recipeId: 'install', revision: '1' } });
    const recipe = { id: 'install', revision: '1', title: 'Install',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'network-client' }] }] };
    expect(ingestPluginManifestV2({ ...recipeManifest, contributes: { ...recipeManifest.contributes, machineRecipes: [recipe] } }).ok).toBe(true);
    expect(ingestPluginManifestV2({ ...recipeManifest, contributes: { ...recipeManifest.contributes, machineRecipes: [{ ...recipe, revision: '2' }] } }))
      .toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'plugin_manifest_dangling_reference', path: ['contributes', 'accessProviders', 0, 'install', 'ref'],
      })]) });
    expect(PluginContributesV2Schema.safeParse({ accessProviders: [descriptor], actions: actions.map(action =>
      action.id === 'inspect' ? { ...action, dangerLevel: 'writesLocal' } : action) }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ accessProviders: [{ ...descriptor, targets: ['homeRelay'] }], actions }).success).toBe(false);
    expect(roles.joinInput.safeParse({ machineId: 'machine', config: { managementUrl: 'https://example.test', rawKey: 'secret' }, credentialRefs: [] }).success).toBe(false);
    expect(roles.result.safeParse({ kind: 'confirmed', facts: { state: 'ready', arbitrary: true } }).success).toBe(false);
  });

  it('admits provider-neutral reviewed membership programs only with exact canonical role inputs', () => {
    const config = defineProtocolObject({}, { policy: 'closed' });
    const roles = defineAccessProviderSchemas({ config });
    const program = (role: 'join' | 'leave') => ({ id: `network-${role}`, revision: '1', title: role,
      inputSchema: roles[`${role}Input`].jsonSchema,
      steps: [{ id: role, kind: 'command', executable: '/usr/bin/network-client', args: [role],
        check: { executable: '/usr/bin/network-client', args: ['status'], unsatisfiedExitCodes: [1] } }],
    });
    const descriptor = { id: 'network', title: 'Network', icon: 'network', schemaVersion: 1,
      targets: ['machine'], capabilities: ['privateNetwork'], exposure: 'privateNetwork',
      configSchema: config.jsonSchema, inboundPorts: [], credentialPurposes: [],
      actions: { inspect: 'inspect', join: 'join', leave: 'leave' },
      membership: { join: program('join'), leave: program('leave') } };
    const actions = (['inspect', 'join', 'leave'] as const).map(role => ({
      id: role, title: role, scopes: ['machine'], surfaces: ['plugin'], execution: { target: 'daemon' },
      dangerLevel: role === 'inspect' ? 'safe' : 'externalSideEffect',
      inputSchema: roles[`${role}Input`].jsonSchema, resultSchema: roles.result.jsonSchema,
    }));
    expect(PluginContributesV2Schema.safeParse({ accessProviders: [descriptor], actions }).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({ accessProviders: [{ ...descriptor, membership: {
      ...descriptor.membership, join: { ...descriptor.membership.join, inputSchema: config.jsonSchema },
    } }], actions }).success).toBe(false);
    expect(AccessProviderContributionV1Schema.safeParse({ ...descriptor, capabilities: ['management'] }).success).toBe(false);
  });
  it('retains purpose-bound revisioned references but refuses inline secrets and ambiguous purpose bindings', () => {
    const selection = { provider: { pluginId: 'example.network', localId: 'network' }, config: {}, credentialRefs: [
      { purpose: 'network.join', credentialRef: { kind: 'savedSecret', ref: 'happier:shared-secret:v1:secret', resourceRevision: 2 } },
    ] };
    expect(AccessProviderSelectionV1Schema.safeParse(selection).success).toBe(true);
    expect(AccessProviderSelectionV1Schema.safeParse({ ...selection, credentialRefs: [...selection.credentialRefs, ...selection.credentialRefs] }).success).toBe(false);
    expect(AccessProviderSelectionV1Schema.safeParse({ ...selection, credentialRefs: [{ purpose: 'network.join', credentialRef: { kind: 'savedSecret', ref: 'happier:shared-secret:v1:secret', resourceRevision: 2, token: 'raw' } }] }).success).toBe(false);
    expect(AccessProviderSelectionV1Schema.safeParse({ ...selection, credentialRefs: [{ purpose: 'network.join', credentialRef: { kind: 'savedSecret', ref: 'happier:shared-secret:v1:secret' } }] }).success).toBe(false);
  });
  it('accepts native Home-only local ingress without inventing HTTPS route capabilities', () => {
    const descriptor = {
      id: 'local-only', title: 'Local only', icon: 'network', schemaVersion: 1,
      targets: ['homeRelay'], capabilities: ['ingress'], exposure: 'local',
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
      inboundPorts: [], credentialPurposes: [],
      actions: { inspect: 'inspect', configure: 'configure', disable: 'disable' },
    };
    expect(AccessProviderContributionV1Schema.parse(descriptor)).toMatchObject({ id: 'local-only' });
    expect(AccessProviderContributionV1Schema.safeParse({ ...descriptor, targets: ['domainRoute'] }).success).toBe(false);
  });
  it('admits access declarations through the canonical family and rejects undeclared same-plugin roles', () => {
    const configSchema = { type: 'object', properties: { managementUrl: { type: 'string' } }, required: ['managementUrl'], additionalProperties: false };
    const descriptor = {
      id: 'private-network', title: 'Private network', icon: 'network', schemaVersion: 1,
      targets: ['machine'], capabilities: ['management', 'privateNetwork'], exposure: 'privateNetwork',
      configSchema, inboundPorts: [], credentialPurposes: [{ purpose: 'network.join', required: true }],
      actions: { inspect: 'inspect', join: 'join', leave: 'leave' },
    };
    // Missing roles must produce a family-specific diagnostic rather than an
    // unknown-family error: it is the actual manifest admission boundary.
    const result = PluginContributesV2Schema.safeParse({ accessProviders: [descriptor], actions: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === 'accessProviders' && issue.path.includes('inspect'))).toBe(true);
    expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'accessProviders')).toMatchObject({
      activationDemand: 'declarative', projectionFamily: 'accessProviders', allowedRuntimeRegistration: null,
    });
  });
});
