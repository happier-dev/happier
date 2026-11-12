import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

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

it('retains a successful half of a connection pair and retries only with the provider continuation and recorded custody', async () => {
  const pooledRef = formatSharedSavedSecretRefV1('pooled');
  const directRef = formatSharedSavedSecretRefV1('direct');
  const pluginId = 'com.example.managed-database';
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const reference = { type: 'object', properties: { ref: { type: 'string' }, resourceRevision: { type: 'number' } },
    required: ['ref', 'resourceRevision'], additionalProperties: false } as const;
  const previous = { type: 'object', properties: { status: { type: 'string' },
    connections: { type: 'object', properties: { DATABASE_URL: reference, DIRECT_URL: reference }, additionalProperties: false },
    incomplete: { type: 'array', items: { type: 'string' } } }, required: ['status', 'connections', 'incomplete'], additionalProperties: false } as const;
  const common = DeploymentTargetRoleInputProtocolSchemasV1['connectionSecret.save'].jsonSchema;
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Managed database',
    actions: { save: { title: 'Save connections', execution, surfaces: ['ui'], dangerLevel: 'writesLocal', readOnly: false,
      confirmation: { title: 'Save connections?' }, inputSchema: { ...common,
        properties: { ...common.properties, previous } }, resultSchema: previous, run: async () => ({}) } },
    deploymentTargets: { database: { role: 'data', title: 'Managed database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, dataV1: { connectionSecret: { save: 'save' } } } } });
  const serverId = await homes.addHome({ name: 'Managed database', serverUrl: 'https://managed-data.test',
    serverIdentityId: 'srv_managed_data', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'database', role: 'data', targetKind: 'database', machines: [], members: [],
    source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } } });
  const linked = { targetLink, content: { providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' },
    providerEnvironment: { kind: 'custom' as const, id: 'main' }, credentialPrincipal: { kind: 'account' as const, accountId: 'original-owner',
      purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'database.manage' },
      target: { kind: 'account' as const, account: { service: { pluginId, localId: 'database' }, accountId: 'original-token' } } } } };
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: account.accountLifetime.scope.serverId }), targetLinks: [linked] });
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
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={detail} linked={detail.targetLinks[0]}
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
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(bind()!.props.disabled).toBe(false); });
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


it('reviews native creation options, retains an ambiguous create and continues through exact adoption without replay', async () => {
  const pluginId = 'com.example.managed-create';
  const service = { pluginId: 'com.example.managed-account', localId: 'account' };
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const preparation = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties!;
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
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.provisionOptions'].jsonSchema, run: async () => ({}) },
      create: { ...common, title: 'Create', dangerLevel: 'writesRemote', readOnly: false, confirmation: { title: 'Create database?' },
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.provision'].jsonSchema, run: async () => ({}) },
      link: { ...common, title: 'Inspect project', dangerLevel: 'safe', readOnly: true,
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.link'].jsonSchema, run: async () => ({}) },
    }, deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, dataV1: { projects: { provisionOptionsAction: 'options', provision: 'create', link: 'link' } } } } });
  const serverId = await homes.addHome({ name: 'Create managed', serverUrl: 'https://managed-create.test',
    serverIdentityId: 'srv_managed_create', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
  const calls: string[] = [];
  await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
    actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
      const input = getActionSpec('action.invoke').inputSchema.parse(raw);
      calls.push(input.action.localId);
      expect(input.input).toMatchObject({ credentialPrincipal: { purpose: { consumer: input.action } } });
      return input.action.localId === 'options' ? { plan: 'standard', price: 'unknown' }
        : input.action.localId === 'create' ? { status: 'outcome_unknown', recovery: 'Inspect the exact native project' }
        : { state: 'provisioned', providerIdentity: { providerAccountId: 'organization', providerResourceId: 'exact-project', providerEnvironment: 'main' },
          providerEnvironment: { kind: 'custom', id: 'main' } };
    } });
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={detail} lifetime={account.accountLifetime}
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
    expect(run()!.props.disabled).toBe(true);
    await act(async () => screen.findAllByType(ActionInputFields).find(node =>
      node.props.fields.some((field: { path: string }) => field.path === 'providerAccountId'))!.props.onPatch({ providerAccountId: 'organization' }));
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

it('pages native branches and creates from a linked target with recorded custody and host request identity', async () => {
  const pluginId = 'com.example.managed-branches';
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const input = DeploymentTargetRoleInputProtocolSchemasV1['branches.list'].jsonSchema;
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Database branches',
    actions: { branches: { title: 'Read branches', execution, surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
      inputSchema: input,
      resultSchema: { type: 'object', properties: { branches: { type: 'array', items: { type: 'object',
        properties: { branchId: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' } },
        required: ['branchId', 'name', 'status'], additionalProperties: false } }, nextCursor: { type: 'string' } },
        required: ['branches'], additionalProperties: false }, run: async () => ({}) },
      create: { title: 'Create branch', execution, surfaces: ['ui'], dangerLevel: 'writesRemote', readOnly: false,
        confirmation: { title: 'Create this branch?' },
        inputSchema: { ...input, properties: { ...input.properties, requestKey: { type: 'string', minLength: 1 } },
          required: [...input.required ?? [], 'requestKey'], additionalProperties: false },
        resultSchema: { type: 'object', properties: { status: { type: 'string' },
          providerIdentity: DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties!.providerIdentity!,
          providerEnvironment: DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties!.providerEnvironment! },
          required: ['status', 'providerIdentity', 'providerEnvironment'], additionalProperties: false }, run: async () => ({}) } },
    deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, dataV1: { branches: { listAction: 'branches', create: 'create' } } } } });
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
      providerResourceId: 'project', providerEnvironment: 'main' }, providerEnvironment: { kind: 'custom', id: 'main' }, credentialPrincipal: principal } }] });
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
          providerResourceId: 'project', providerEnvironment: 'created-branch' }, providerEnvironment: { kind: 'custom', id: 'created-branch' } };
      }
      return value.cursor ? { branches: [{ branchId: 'branch-2', name: 'Second branch', status: 'ready' }] }
        : { branches: [{ branchId: 'branch-1', name: 'First branch', status: 'ready' }], nextCursor: 'native-page-2' };
    } });
  const screen = await renderScreen(<DeploymentManagedDataSheet detail={detail} linked={detail.targetLinks[0]}
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
