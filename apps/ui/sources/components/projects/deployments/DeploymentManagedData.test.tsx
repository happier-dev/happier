import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin, deploymentTargetRoleWithNativeSelectorV1, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { storage } from '@/sync/domains/state/storageStore';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/jsonSchemaValidation';
import { plugin as neonPlugin } from '../../../../../../packages/plugins/deployment-neon/src/manifest';
import { plugin as supabasePlugin } from '../../../../../../packages/plugins/deployment-supabase/src/manifest';

const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
const nativeSelectorSchema = { ...closed, properties: { branchId: { type: 'string', minLength: 1 } } } as const;
const roleSchema = (role: keyof typeof DeploymentTargetRoleInputProtocolSchemasV1) =>
  deploymentTargetRoleWithNativeSelectorV1(DeploymentTargetRoleInputProtocolSchemasV1[role].jsonSchema, nativeSelectorSchema);
const preparation = deploymentTargetRoleWithNativeSelectorV1(DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema, nativeSelectorSchema).properties!;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { createDeploymentActions } = await import('./deploymentActions');
const { DeploymentManagedDataSheet } = await import('./DeploymentManagedData');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
afterEach(standardCleanup);

function connectedProfile(service: { pluginId: string; localId: string }, accountId: string, organizationId: string) {
  return QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId },
    status: 'connected', authenticationModeId: 'token', configurationReady: true, configurationRevision: 'configuration',
    revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', providerIdentity: { organizationId }, scopes: [] });
}

it.each([neonPlugin, supabasePlugin])('offers first-connection recovery with no saved accounts for $manifest.id', async plugin => {
  const serverId = await homes.addHome({ name: 'Fresh managed data', serverUrl: 'https://fresh-managed-data.test',
    accountId: 'fresh-owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' }),
    accountLifetime: account.accountLifetime, publishProjection: true });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
  const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
  storage.setState({ profileScope: account.accountLifetime.scope,
    profile: AccountProfileSchema.parse({ id: 'fresh-owner' }) });
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={readDetail(detail)} lifetime={account.accountLifetime}
    actions={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId)} onApproval={() => {}} onClose={() => {}} />);
  try {
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    const { EmptyState } = await import('@/components/ui/empty/EmptyState');
    const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
    await waitForHomeGovernance(() => expect(screen.findAllByType(SelectionTiles)
      .some(node => node.props.testIdPrefix === 'managed-data.provider')).toBe(true));
    // The existing platform-link flow uses EmptyState's primary action to open the canonical Connect sheet.
    expect(screen.findAllByType(EmptyState).some(node => typeof node.props.primaryAction?.onPress === 'function')).toBe(true);
    expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(0);
    // Connect is the sheet's one action until the provider is connected.
    expect(screen.findAllByType(RoundButton).some(node => node.props.testID === 'managed-data.run')).toBe(false);
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});

it.each([neonPlugin, supabasePlugin])('dispatches real $manifest.id project and region reads with the selected organization', async plugin => {
  const manifest = plugin.manifest;
  const service = { pluginId: manifest.id, localId: manifest.contributes.connectedAccountDescriptors[0]!.id };
  const serverId = await homes.addHome({ name: 'Managed read', serverUrl: 'https://managed-read.test',
    serverIdentityId: 'srv_managed_read', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const execution = { artifactId: 'account-runtime', exportName: 'activateAccount' };
  const installed = await installPortableAccountPluginReleaseForTest({ manifest,
    activate: api => plugin.activateAccount(api, execution), accountLifetime: account.accountLifetime, publishProjection: true });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
  storage.setState({ profileScope: account.accountLifetime.scope,
    profile: { ...storage.getState().profile, connectedAccountsV4: [connectedProfile(service, 'management-token', 'configured-organization')] } });
  const calls: string[] = [];
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      const invocation = getActionSpec('action.invoke').inputSchema.parse(raw);
      const declaration = manifest.contributes.actions.find(action => action.id === invocation.action.localId)!;
      if (!declaration.inputSchema) throw new Error('Managed read requires its declared input schema');
      expect(compilePluginJsonSchema(declaration.inputSchema)(invocation.input)).toBe(true);
      expect(invocation.input).toMatchObject({ environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        providerAccountId: 'configured-organization',
        credentialRef: { service, accountId: 'management-token' },
        credentialPrincipal: { kind: 'account', accountId: account.accountLifetime.scope.accountId,
          purpose: { consumer: invocation.action, purpose: 'deploy-manage' },
          target: { kind: 'account', account: { service, accountId: 'management-token' } } } });
      expect(invocation.input).not.toHaveProperty('providerIdentity');
      calls.push(invocation.action.localId);
      const projects = invocation.action.localId.includes('projects-list');
      return manifest.id === neonPlugin.manifest.id
        ? projects ? { projects: [], unavailableProjectIds: [] }
          : { providerAccountId: 'configured-organization', plan: 'standard', regions: [], price: 'unknown' }
        : projects ? { projects: [] }
          : { organizationSlug: 'configured-organization', regions: [], subscription: 'organization', price: 'unknown', entitlementsObserved: true };
    } });
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={readDetail(detail)} lifetime={account.accountLifetime}
    actions={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId)} onApproval={() => {}} onClose={() => {}} />);
  try {
    const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
    const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    const operation = () => screen.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === 'managed-data.operation');
    const run = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'managed-data.run');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(operation()).toBeDefined(); });
    const provider = () => screen.findAllByType(SelectionTiles).find(node => node.props.testIdPrefix === 'managed-data.provider');
    const providerKey = `${manifest.id}/${manifest.contributes.deploymentTargets[0]!.id}`;
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(provider()!.props.options).toEqual(expect.arrayContaining([expect.objectContaining({ id: providerKey })]));
    });
    await act(async () => provider()!.props.onChange(providerKey));
    expect(provider()!.props.value).toBe(providerKey);
    // The person chooses what to do in their own words; creation reads its options as its own review step.
    const ids = operation()!.props.options.map((option: { id: string }) => option.id);
    expect(ids).not.toContain('projects.provisionOptions');
    // Creating leads and finding what is there comes last, whatever order the provider declared.
    expect(ids.indexOf('projects.provision')).toBeLessThan(ids.indexOf('projects.list'));
    await act(async () => operation()!.props.onChange('projects.list'));
    await act(async () => screen.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({ kind: 'account', account: { service, accountId: 'management-token' } }));
    expect(run()!.props.disabled).toBe(false);
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(calls, JSON.stringify({
      cards: screen.findAllByType(SurfaceStateCard).map(node => ({ kind: node.props.kind, code: node.props.diagnosticCode })),
      requests: homes.requests.map(request => `${request.method} ${request.path.split('?')[0]}`),
    })).toHaveLength(1); expect(run()!.props.loading).toBe(false); });
    await act(async () => operation()!.props.onChange('projects.provision'));
    expect(run()!.props.disabled).toBe(false);
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(calls).toHaveLength(2); expect(run()!.props.loading).toBe(false); });
    expect(calls[0]).toContain('projects-list');
    expect(calls[1]).toContain('provision-options');
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});

it.each([false, true])('defaults the saved organization, retains recovery and requires each variable replacement to be selected (existing=%s)', async (existing) => {
  const pooledRef = formatSharedSavedSecretRefV1('pooled');
  const directRef = formatSharedSavedSecretRefV1('direct');
  const pluginId = 'com.example.managed-database';
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const reference: PluginJsonSchemaV2 = { type: 'object', properties: { ref: { type: 'string' }, resourceRevision: { type: 'number' } },
    required: ['ref', 'resourceRevision'], additionalProperties: false };
  const previous: PluginJsonSchemaV2 = { type: 'object', properties: { status: { type: 'string' },
    connections: { type: 'object', properties: { DATABASE_URL: reference, DIRECT_URL: reference }, additionalProperties: false },
    incomplete: { type: 'array', items: { type: 'string' } } }, required: ['status', 'connections', 'incomplete'], additionalProperties: false };
  const common = roleSchema('connectionSecret.save');
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Managed database',
    actions: { save: { title: 'Save connections', execution, surfaces: ['ui'], dangerLevel: 'writesLocal', readOnly: false,
      confirmation: { title: 'Save connections?' }, inputSchema: { ...common,
        properties: { ...common.properties, previous } }, resultSchema: previous, run: async () => ({}) } },
    deploymentTargets: { database: { role: 'data', title: 'Managed database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, nativeSelectorSchema, dataV1: { connectionSecret: { save: 'save' } } } } });
  const serverId = await homes.addHome({ name: 'Managed database', serverUrl: 'https://managed-data.test',
    serverIdentityId: 'srv_managed_data', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'database', role: 'data', targetKind: 'database', machines: [], members: [],
    source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } } });
  const linked = { targetLink, content: { providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' },
    providerEnvironment: { kind: 'native' as const, selection: { branchId: 'main' } }, credentialPrincipal: { kind: 'account' as const, accountId: 'original-owner',
      purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'database.manage' },
      target: { kind: 'account' as const, account: { service: { pluginId, localId: 'database' }, accountId: 'original-token' } } } } };
  const base = createDeploymentEnvironmentDetailV1();
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: account.accountLifetime.scope.serverId }), targetLinks: [linked],
    ...(existing ? { content: { ...base.content, bindings: ['DATABASE_URL', 'DIRECT_URL'].map(name => ({ purpose: 'variable' as const, name, phase: 'runtime' as const, source: { kind: 'value' as const, value: 'existing value' } })) } } : {}) });
  const partial = { status: 'partial', connections: { DATABASE_URL: { ref: pooledRef, resourceRevision: 3 } }, incomplete: ['DIRECT_URL'] };
  const calls: unknown[] = [];
  const bindings: unknown[] = [];
  homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
    environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'deployments.bindings.set', tokenEpoch: 0, deploymentSource: { id: detail.environment.projectSourceId, revision: 1 },
    execute: input => { bindings.push(input); return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 }; } });
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      const invocation = getActionSpec('action.invoke').inputSchema.parse(raw);
      calls.push(invocation.input);
      expect(invocation.action).toEqual({ pluginId, localId: 'save' });
      expect(invocation.input).toMatchObject({ credentialPrincipal: linked.content.credentialPrincipal,
        credentialRef: linked.content.credentialPrincipal.target.account, targetLinkId: targetLink.id,
        expectedTargetLinkRevision: targetLink.revision });
      return calls.length === 1 ? partial : { ...partial, status: 'complete', incomplete: [],
        connections: { ...partial.connections, DIRECT_URL: { ref: directRef, resourceRevision: 4 } } };
    } });
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={readDetail(detail)} linked={detail.targetLinks[0]}
    lifetime={account.accountLifetime} actions={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId)}
    onApproval={() => {}} onClose={() => {}} />);
  try {
    const run = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'managed-data.run');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(run(), JSON.stringify(screen.findAllByType(SurfaceStateCard)
      .map(node => ({ kind: node.props.kind, title: node.props.title, code: node.props.diagnosticCode })))).toBeDefined(); });
    expect(calls).toHaveLength(0);
    await act(async () => run()!.props.onPress());
    const partialCard = () => screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'managed-data.partial');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(partialCard()).toBeDefined(); });
    expect(screen.root.findAll(node => node.props.testID === 'managed-data.connection:DATABASE_URL')).not.toHaveLength(0);
    const { Item } = await import('@/components/ui/lists/Item');
    const bind = () => screen.findAllByType(Item).find(node => node.props.testID === 'managed-data.bind');
    expect(bind()!.props.disabled).toBe(true);
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(calls).toHaveLength(2); });
    expect(calls[1]).toMatchObject({ previous: partial });
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(screen.root.findAll(node => node.props.testID === 'managed-data.connection:DIRECT_URL').length).toBeGreaterThan(0); });
    if (existing) {
      expect(bind()!.props.disabled).toBe(true);
      await act(async () => bind()!.props.onPress());
      expect(bindings).toHaveLength(0);
      const { Switch } = await import('@/components/ui/forms/Switch');
      const replace = (name: string) => screen.findAllByType(Switch).find(node => node.props.testID === `managed-data.replace.${name}`)!;
      await act(async () => replace('DATABASE_URL').props.onValueChange(true));
      expect(bind()!.props.disabled).toBe(true);
      await act(async () => replace('DIRECT_URL').props.onValueChange(true));
    }
    expect(bind()!.props.disabled).toBe(false);
    await act(async () => bind()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(bindings, JSON.stringify({
      cards: screen.findAllByType(SurfaceStateCard).map(node => ({ title: node.props.title, code: node.props.diagnosticCode })),
      requests: homes.requests.map(request => `${request.method} ${request.path.split('?')[0]}`),
    })).toHaveLength(1); });
    expect(bindings[0]).toMatchObject({ environmentId: detail.environment.id, set: [
      { purpose: 'variable', phase: 'runtime', name: 'DATABASE_URL', source: { kind: 'secret', ref: pooledRef, resourceRevision: 3 } },
      { purpose: 'variable', phase: 'runtime', name: 'DIRECT_URL', source: { kind: 'secret', ref: directRef, resourceRevision: 4 } },
    ] });
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});


/** The read projection the sheet receives: an opened detail without a linked runtime or retained receipts. */
function readDetail(detail: ReturnType<typeof createDeploymentEnvironmentDetailV1>) {
  return { ...detail, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
}

it('reviews native creation options, retains an ambiguous create and continues through exact adoption without replay', async () => {
  const pluginId = 'com.example.managed-create';
  const service = { pluginId: 'com.example.managed-account', localId: 'account' };
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const common = { execution, surfaces: ['ui'] as const, hostAccess: ['manage'],
    inputHints: { fields: [{ path: 'providerAccountId', title: 'Organization', widget: 'text', required: true }] } as const,
    resultSchema: { type: 'object', additionalProperties: false, properties: {
      providerIdentity: preparation.providerIdentity!, providerEnvironment: preparation.providerEnvironment!,
      state: { type: 'string' }, status: { type: 'string' }, recovery: { type: 'string' },
      plan: { type: 'string' }, price: { type: 'string' } } } as const,
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }] };
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Database',
    hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts', reason: 'Manage a database',
      scope: { serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
    actions: {
      list: { ...common, title: 'List projects', dangerLevel: 'safe', readOnly: true,
        inputSchema: roleSchema('projects.list'), run: async () => ({}) },
      options: { ...common, title: 'Options', dangerLevel: 'safe', readOnly: true,
        inputSchema: roleSchema('projects.provisionOptions'), run: async () => ({}) },
      create: { ...common, title: 'Create', dangerLevel: 'writesRemote', readOnly: false, confirmation: { title: 'Create database?' },
        inputSchema: roleSchema('projects.provision'), run: async () => ({}) },
      link: { ...common, title: 'Inspect project', dangerLevel: 'safe', readOnly: true,
        inputSchema: roleSchema('projects.link'), run: async () => ({}) },
    }, deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, nativeSelectorSchema, dataV1: { projects: { listAction: 'list', provisionOptionsAction: 'options', provision: 'create', link: 'link' } } } } });
  const serverId = await homes.addHome({ name: 'Create managed', serverUrl: 'https://managed-create.test',
    serverIdentityId: 'srv_managed_create', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
  const calls: string[] = [];
  storage.setState({ profileScope: account.accountLifetime.scope,
    profile: { ...storage.getState().profile, connectedAccountsV4: [connectedProfile(service, 'management-token', 'configured-organization')] } });
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      const input = getActionSpec('action.invoke').inputSchema.parse(raw);
      calls.push(input.action.localId);
      expect(input.input).toMatchObject({ providerAccountId: 'organization', credentialPrincipal: { purpose: { consumer: input.action } } });
      return input.action.localId === 'options' ? { plan: 'standard', price: 'unknown' }
        : input.action.localId === 'create' ? { status: 'outcome_unknown', recovery: 'Inspect the exact native project' }
        : { state: 'provisioned', providerIdentity: { providerAccountId: 'organization', providerResourceId: 'exact-project', providerEnvironment: 'main' },
          providerEnvironment: { kind: 'native', selection: { branchId: 'main' } } };
    } });
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={readDetail(detail)} lifetime={account.accountLifetime}
    actions={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId)} onApproval={() => {}} onClose={() => {}} />);
  try {
    const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    const operation = () => screen.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === 'managed-data.operation');
    const run = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'managed-data.run');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(operation()).toBeDefined(); });
    await act(async () => operation()!.props.onChange('projects.provision'));
    await act(async () => screen.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({ kind: 'account', account: { service, accountId: 'management-token' } }));
    const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
    const organizationField = () => screen.findAllByType(ActionInputFields).find(node =>
      node.props.fields.some((field: { path: string }) => field.path === 'providerAccountId'))!;
    expect(organizationField().props.input.providerAccountId).toBe('configured-organization');
    expect(run()!.props.disabled).toBe(false);
    await act(async () => operation()!.props.onChange('projects.list'));
    expect(organizationField().props.input.providerAccountId).toBe('configured-organization');
    expect(run()!.props.disabled).toBe(false);
    await act(async () => organizationField().props.onPatch({ providerAccountId: '' }));
    await act(async () => operation()!.props.onChange('projects.provision'));
    expect(organizationField().props.input.providerAccountId).toBe('');
    expect(run()!.props.disabled).toBe(true);
    await act(async () => screen.findAllByType(ActionInputFields).find(node =>
      node.props.fields.some((field: { path: string }) => field.path === 'providerAccountId'))!.props.onPatch({ providerAccountId: 'organization' }));
    await act(async () => operation()!.props.onChange('projects.list'));
    expect(organizationField().props.input.providerAccountId).toBe('organization');
    await act(async () => operation()!.props.onChange('projects.provision'));
    expect(calls).toEqual([]);
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(calls).toEqual(['options']); expect(run()!.props.loading).toBe(false); });
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(calls).toEqual(['options', 'create']);
      expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.testID === 'managed-data.unknown')).toBe(true); });
    expect(run()!.props.disabled).toBe(true);
    expect(screen.root.findAll(node => node.props.testID === 'managed-data.link')).toHaveLength(0);
    await act(async () => operation()!.props.onChange('projects.link'));
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(screen.findAllByType(RoundButton).some(node => node.props.testID === 'managed-data.link')).toBe(true); });
    expect(calls).toEqual(['options', 'create', 'link']);
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});

it('hands a creation workflow to explicit service selection before confirming its Link', async () => {
  const pluginId = 'com.example.workflow-database';
  const service = { pluginId: 'com.example.workflow-account', localId: 'account' };
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const string = { type: 'string', minLength: 1 } as const;
  const scope = { workspaceId: 'workspace-id', projectId: 'project-id', railwayEnvironmentId: 'preview-id' };
  const scopeFields = [
    { path: 'workspaceId', title: 'Workspace', widget: 'text', required: true },
    { path: 'projectId', title: 'Project', widget: 'text', required: true },
    { path: 'railwayEnvironmentId', title: 'Environment', widget: 'text', required: true },
  ] as const;
  const scopeProperties = { workspaceId: string, projectId: string, railwayEnvironmentId: string };
  const choices = [{ value: 'database-old', label: 'Orders · database-old' }, { value: 'database-new', label: 'Orders · database-new' }];
  const operands = (role: 'projects.link' | 'projects.provision') => {
    const base = roleSchema(role);
    return { ...base, properties: { ...base.properties, ...scopeProperties, ...(role === 'projects.link' ? { serviceId: string } : {}) },
      required: [...base.required ?? [], ...Object.keys(scopeProperties), ...(role === 'projects.link' ? ['serviceId'] : [])] };
  };
  const common = { execution, surfaces: ['ui'] as const, hostAccess: ['manage'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }] };
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Workflow database',
    hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts', reason: 'Manage a database',
      scope: { serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
    actions: {
      create: { ...common, title: 'Create', dangerLevel: 'writesRemote', readOnly: false, confirmation: { title: 'Create database?' },
        inputHints: { fields: scopeFields }, inputSchema: operands('projects.provision'),
        resultSchema: { ...closed, properties: { ...scopeProperties, status: string, workflowId: string } }, run: async () => ({}) },
      inspect: { ...common, title: 'Inspect service', dangerLevel: 'safe', readOnly: true,
        inputHints: { fields: [...scopeFields, { path: 'serviceId', title: 'Database service', widget: 'select', required: true, options: choices }] },
        inputSchema: operands('projects.link'), resultSchema: { ...closed, properties: {
          providerIdentity: preparation.providerIdentity!, providerEnvironment: preparation.providerEnvironment!, engine: string,
        } }, run: async () => ({}) },
    }, deploymentTargets: { database: { role: 'data', title: 'Workflow database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, nativeSelectorSchema, dataV1: { projects: { provision: 'create', link: 'inspect' } } } } });
  const serverId = await homes.addHome({ name: 'Managed workflow', serverUrl: 'https://managed-workflow.test',
    serverIdentityId: 'srv_managed_workflow', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
  storage.setState({ profileScope: account.accountLifetime.scope,
    profile: { ...storage.getState().profile, connectedAccountsV4: [connectedProfile(service, 'management-token', scope.workspaceId)] } });
  const calls: unknown[] = [];
  const links: unknown[] = [];
  const providerIdentity = { providerAccountId: scope.workspaceId, providerResourceId: `${scope.projectId}/database-new`, providerEnvironment: scope.railwayEnvironmentId };
  const providerEnvironment = { kind: 'native', selection: {} };
  homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
    environment: detail.environment, targetLinks: [] } });
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'deployments.targets.link', tokenEpoch: 0, deploymentSource: { id: detail.environment.projectSourceId, revision: 1 },
    execute: input => {
      links.push(input);
      return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
        targetLinkId: 'data-link', targetLinkRevision: 1 };
    } });
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      const invocation = getActionSpec('action.invoke').inputSchema.parse(raw);
      calls.push({ action: invocation.action.localId, input: invocation.input });
      if (invocation.action.localId === 'create') return { status: 'adoption_required', workflowId: 'workflow-123', ...scope };
      return { engine: 'postgresql', providerIdentity, providerEnvironment };
    } });
  const onClose = vi.fn();
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={readDetail(detail)} lifetime={account.accountLifetime}
    actions={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId)} onApproval={() => {}} onClose={onClose} />);
  try {
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
    const field = (path: string) => screen.findAllByType(ActionInputFields).find(node => node.props.fields[0]?.path === path);
    const run = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'managed-data.run');
    const link = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'managed-data.link');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(run()).toBeDefined(); });
    await act(async () => screen.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({ kind: 'account', account: { service, accountId: 'management-token' } }));
    for (const [path, value] of Object.entries(scope)) await act(async () => field(path)!.props.onPatch({ [path]: value }));
    expect(run()!.props.disabled).toBe(false);
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(calls).toEqual([expect.objectContaining({ action: 'create', input: expect.objectContaining(scope) })]);
      expect(run()!.props.loading).toBe(false);
    });
    expect(links).toEqual([]);
    expect(link()).toBeUndefined();
    expect(screen.getTextContent()).toContain('workflow-123');
    expect(screen.findByTestId('managed-data.adoption')).not.toBeNull();
    expect(field('projectId')).toBeUndefined();
    expect(field('railwayEnvironmentId')).toBeUndefined();
    expect(field('serviceId')!.props.input.serviceId).toBeUndefined();
    expect(field('serviceId')!.props.resolveFieldOptions(field('serviceId')!.props.fields[0])).toEqual(choices);
    expect(run()!.props.disabled).toBe(true);
    await act(async () => field('serviceId')!.props.onPatch({ serviceId: 'database-new' }));
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(link()).toBeDefined(); });
    expect(calls).toEqual([
      expect.objectContaining({ action: 'create', input: expect.objectContaining(scope) }),
      expect.objectContaining({ action: 'inspect', input: expect.objectContaining({ ...scope, serviceId: 'database-new' }) }),
    ]);
    expect(links).toEqual([]);
    expect(screen.getTextContent()).toContain('database-new');
    await act(async () => link()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(onClose).toHaveBeenCalledOnce(); });
    expect(links).toEqual([expect.objectContaining({ environmentId: detail.environment.id, role: 'data',
      provider: expect.objectContaining({ providerIdentity, providerEnvironment }) })]);
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});

it('pages native branches and creates from a linked target with recorded custody and host request identity', async () => {
  const pluginId = 'com.example.managed-branches';
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const input = roleSchema('branches.list');
  const createInput = roleSchema('branches.create');
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Database branches',
    actions: { branches: { title: 'Read branches', execution, surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
      inputSchema: input,
      resultSchema: { type: 'object', properties: { branches: { type: 'array', items: { type: 'object',
        properties: { branchId: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' } },
        required: ['branchId', 'name', 'status'], additionalProperties: false } }, nextCursor: { type: 'string' } },
        required: ['branches'], additionalProperties: false }, run: async () => ({}) },
      create: { title: 'Create branch', execution, surfaces: ['ui'], dangerLevel: 'writesRemote', readOnly: false,
        confirmation: { title: 'Create this branch?' },
        inputSchema: { ...createInput, properties: { ...createInput.properties, requestKey: { type: 'string', minLength: 1 } },
          required: [...createInput.required ?? [], 'requestKey'], additionalProperties: false },
        resultSchema: { type: 'object', properties: { status: { type: 'string' },
          providerIdentity: preparation.providerIdentity!,
          providerEnvironment: preparation.providerEnvironment! },
          required: ['status', 'providerIdentity', 'providerEnvironment'], additionalProperties: false }, run: async () => ({}) } },
    deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, nativeSelectorSchema, dataV1: { branches: { listAction: 'branches', create: 'create' } } } } });
  const serverId = await homes.addHome({ name: 'Branches', serverUrl: 'https://managed-branches.test',
    serverIdentityId: 'srv_managed_branches', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'database', machines: [], members: [], role: 'data', source: { kind: 'plugin',
    contribution: { pluginId, localId: 'database' } }, targetKind: 'database' });
  const principal = { kind: 'account' as const, accountId: 'original-owner',
    purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'database.manage' },
    target: { kind: 'account' as const, account: { service: { pluginId, localId: 'database' }, accountId: 'original-token' } } };
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }),
    targetLinks: [{ targetLink, content: { providerIdentity: { providerAccountId: 'organization',
      providerResourceId: 'project', providerEnvironment: 'main' }, providerEnvironment: { kind: 'native', selection: { branchId: 'main' } }, credentialPrincipal: principal } }] });
  const inputs: Record<string, unknown>[] = [];
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      const invocation = getActionSpec('action.invoke').inputSchema.parse(raw);
      const value = invocation.input as Record<string, unknown>;
      inputs.push(value);
      expect(value).toMatchObject({ credentialPrincipal: principal, targetLinkId: targetLink.id,
        expectedTargetLinkRevision: targetLink.revision });
      if (invocation.action.localId === 'create') {
        expect(value.requestKey).toEqual(expect.any(String));
        return { status: 'provisioned', providerIdentity: { providerAccountId: 'organization',
          providerResourceId: 'project', providerEnvironment: 'created-branch' }, providerEnvironment: { kind: 'native', selection: { branchId: 'created-branch' } } };
      }
      return value.cursor ? { branches: [{ branchId: 'branch-2', name: 'Second branch', status: 'ready' }] }
        : { branches: [{ branchId: 'branch-1', name: 'First branch', status: 'ready' }], nextCursor: 'native-page-2' };
    } });
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={readDetail(detail)} linked={detail.targetLinks[0]}
    lifetime={account.accountLifetime} actions={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId)}
    onApproval={() => {}} onClose={() => {}} />);
  try {
    const { Item } = await import('@/components/ui/lists/Item');
    const run = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'managed-data.run');
    const page = (direction: string) => screen.findAllByType(Item).find(node => node.props.testID === `managed-data.page.${direction}`);
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(run()).toBeDefined(); });
    expect(inputs).toHaveLength(0);
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(page('next')).toBeDefined(); });
    await act(async () => page('next')!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(inputs).toHaveLength(2); expect(page('previous')).toBeDefined(); });
    expect(inputs[1]?.cursor).toBe('native-page-2');
    await act(async () => page('previous')!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(inputs).toHaveLength(3); });
    expect(inputs[2]?.cursor).toBeUndefined();
    const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
    await act(async () => screen.findAllByType(SegmentedChoiceItem).find(node =>
      node.props.testID === 'managed-data.operation')!.props.onChange('branches.create'));
    expect(screen.root.findAll(node => node.props.testID === 'managed-data.field:requestKey')).toHaveLength(0);
    await act(async () => run()!.props.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(inputs).toHaveLength(4);
      expect(screen.findAllByType(RoundButton).some(node => node.props.testID === 'managed-data.link')).toBe(true); });
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});

it('authors duplicate provisioning with an editable saved organization without executing a provider mutation', async () => {
  const provision = roleSchema('projects.provision');
  const pluginId = 'com.example.managed-create';
  const service = { pluginId: 'com.example.managed-account', localId: 'account' };
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const common = { execution, surfaces: ['ui'] as const, hostAccess: ['manage'],
    inputHints: { fields: [{ path: 'providerAccountId', title: 'Organization', widget: 'text', required: true }] } as const,
    resultSchema: { type: 'object', additionalProperties: false, properties: {
      providerIdentity: preparation.providerIdentity!, providerEnvironment: preparation.providerEnvironment!,
      state: { type: 'string' }, status: { type: 'string' }, recovery: { type: 'string' },
      plan: { type: 'string' }, price: { type: 'string' } } } as const,
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }] };
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Database',
    hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts', reason: 'Manage a database',
      scope: { serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
    actions: {
      options: { ...common, title: 'Options', dangerLevel: 'safe', readOnly: true,
        inputSchema: roleSchema('projects.provisionOptions'), run: async () => ({}) },
      create: { ...common, title: 'Create', dangerLevel: 'writesRemote', readOnly: false, confirmation: { title: 'Create database?' },
        inputSchema: { ...provision,
          properties: { ...provision.properties, requestKey: { type: 'string', minLength: 1 } },
          required: [...provision.required ?? [], 'requestKey'] }, run: async () => ({}) },
      link: { ...common, title: 'Inspect project', dangerLevel: 'safe', readOnly: true,
        inputSchema: roleSchema('projects.link'), run: async () => ({}) },
    }, deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, nativeSelectorSchema, dataV1: { projects: { provisionOptionsAction: 'options', provision: 'create', link: 'link' } } } } });
  const serverId = await homes.addHome({ name: 'Create managed', serverUrl: 'https://managed-create.test',
    serverIdentityId: 'srv_managed_create', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
  const { DeploymentManagedDataProvisionEditor } = await import('./DeploymentManagedData');
  const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
  const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
  const executed: unknown[] = [];
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required',
    execute: raw => { executed.push(raw); return {}; } });
  storage.setState({ profileScope: account.accountLifetime.scope,
    profile: { ...storage.getState().profile, connectedAccountsV4: [] } });
  let authored: unknown = undefined;
  let commits = 0;
  const screen = await renderScreen(<React.Profiler id="managed-data-editor" onRender={() => { commits++; }}>
    <DeploymentManagedDataProvisionEditor lifetime={account.accountLifetime}
      contribution={{ pluginId, localId: 'database' }} onChange={value => { authored = value; }} />
  </React.Profiler>);
  try {
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(1); });
    expect(authored).toBeNull();
    await act(async () => screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account', account: { service, accountId: 'new-token' } }));
    expect(authored).toBeNull();
    const rows = [connectedProfile(service, 'new-token', 'configured-organization'), connectedProfile(service, 'other-token', 'other-organization')];
    const requestsBeforeProfile = homes.requests.length;
    const commitsBeforeProfile = commits;
    await act(async () => storage.setState({ profile: { ...storage.getState().profile,
      connectedAccountsV4: [connectedProfile({ ...service, localId: 'another-service' }, 'new-token', 'wrong-organization'), ...rows] } }));
    expect(authored).toMatchObject({ input: { providerAccountId: 'configured-organization' } });
    expect(homes.requests).toHaveLength(requestsBeforeProfile);
    expect(commits - commitsBeforeProfile).toBe(1);
    const settledCommits = commits;
    await act(async () => storage.setState({ profile: { ...storage.getState().profile, timestamp: 123 } }));
    await act(async () => storage.setState({ profile: { ...storage.getState().profile,
      connectedAccountsV4: [rows[0]!, connectedProfile(service, 'other-token', 'other-organization-updated')] } }));
    expect(commits).toBe(settledCommits);
    await act(async () => screen.findAllByType(ActionInputFields)[0]!.props.onPatch({ providerAccountId: '' }));
    expect(authored).toBeNull();
    await act(async () => storage.setState({ profile: { ...storage.getState().profile,
      connectedAccountsV4: [connectedProfile(service, 'new-token', 'refreshed-organization'), rows[1]!] } }));
    expect(screen.findAllByType(ActionInputFields)[0]!.props.input.providerAccountId).toBe('');
    await act(async () => screen.findAllByType(ActionInputFields)[0]!.props.onPatch({ providerAccountId: 'new-organization' }));
    expect(authored).toMatchObject({ action: { pluginId, localId: 'create' }, input: {
      credentialRef: { service, accountId: 'new-token' }, providerAccountId: 'new-organization',
      credentialPrincipal: { purpose: { consumer: { pluginId, localId: 'create' } } }, requestKey: expect.any(String),
    } });
    expect((authored as { input: object }).input).not.toHaveProperty('environmentId');
    await act(async () => screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account', account: { service, accountId: 'new-token' } }));
    expect(authored).toMatchObject({ input: { providerAccountId: 'new-organization' } });
    await act(async () => screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account', account: { service, accountId: 'other-token' } }));
    expect(authored).toMatchObject({ input: { credentialRef: { service, accountId: 'other-token' }, providerAccountId: 'other-organization' } });
    await act(async () => storage.setState({ profileScope: { ...account.accountLifetime.scope, accountId: 'another-owner' } }));
    expect(authored).toBeNull();
    await act(async () => storage.setState({ profileScope: account.accountLifetime.scope }));
    expect(executed).toHaveLength(0);
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});
