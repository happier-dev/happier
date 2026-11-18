import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { dockerEngine } from '../../../../../../packages/plugins/machine-recipes/src/dockerEngine';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
const native = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(native.rpc));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentEnvironmentDraft } = await import('./DeploymentEnvironmentDraft');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { SoftwareInputFields } = await import('@/components/store/StoreSoftwareInputs');
const { MachineSetupRecipeInputs } = await import('@/components/settings/machines/managed/MachineSetupRecipeInputs');
const { DEPLOY_HOST_DOCKER_ITEM } = await import('@happier-dev/protocol/deployments/deployHostReadiness');

it('says a ready Machine is ready to host deploys in its Where card (journey-deploy whereM)', async () => {
  const serverId = await homes.addHome({ name: 'Host ready', serverUrl: 'https://deploy-host-ready-card.test',
    accountId: 'alice', serverIdentityId: `srv_${'3'.repeat(32)}`, currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const previous = storage.getState();
  const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
  const { t } = await import('@/text');
  native.rpc.mockImplementation(async () => ({ ok: false, code: 'unsupported' }));
  try {
    storage.getState().setEndpointConnectivity({ status: 'online', reason: null, attempt: 0,
      nextRetryAt: null, lastConnectedAt: Date.now(), lastDisconnectedAt: null, lastErrorMessage: null });
    // The current setup Plan (a network boundary) reports the Docker recipe satisfied on this Machine.
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'host', installationId: 'host-installation',
      actionId: 'machines.setup.plan', tokenEpoch: 0, requesterInvocation: 'none', execute: raw => {
        const input = ManagedMachineActionInputSchemasV1['machines.setup.plan'].parse(raw);
        if (!('targets' in input)) throw new Error('Expected the production combined Plan request');
        const target = input.targets[0]!;
        return { targets: [{ homeId: target.homeId, machineId: target.machineId, plan: {
          desiredRevision: 0, sources: [{ kind: 'direct', setup: { items: [DEPLOY_HOST_DOCKER_ITEM] } }], exclusions: [],
          support: [{ sourceIndex: 0, itemIndex: 0, status: 'satisfied' }],
        } }], review: { machineId: 'host', machines: [{ machineId: 'host', online: true }] } };
      } });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({
      id: 'host', installationId: 'host-installation', activeAt: Date.now(),
    })]);
    const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null}
      definitionKind="compose" phone={false} actions={null} steps={{ onFrame: () => {}, onExit: () => {} }}
      onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
    try {
      const machine = () => screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine');
      await waitForHomeGovernance(() => expect(machine()?.props.subtitle).toBe(t('newApp.deploy.readyToHost')));
    } finally { await screen.unmount(); }
  } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
});

it.each(['unknown', 'unavailable'] as const)('keeps unknown hosting readiness out of recipe inputs and opens the Machine setup owner (%s)', async outcome => {
  const serverIdentityId = `srv_${(outcome === 'unknown' ? '4' : '5').repeat(32)}`;
  const serverId = await homes.addHome({ name: 'Host unchecked', serverUrl: `https://deploy-host-${outcome}.test`,
    accountId: 'alice', serverIdentityId, currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const previous = storage.getState();
  const ref = DEPLOY_HOST_DOCKER_ITEM.selection.ref;
  const key = `${ref.pluginId}/${ref.recipeId}`;
  const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
    projection: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
      familiesById: { machineRecipes: { family: 'machineRecipes', entriesById: {
        [key]: { id: key, pluginId: ref.pluginId, pluginVersion: '1', definition: { id: ref.recipeId, ...dockerEngine } },
      } } } } });
  native.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
    ? projection : { ok: false, code: 'unsupported' });
  const modes: unknown[] = [];
  try {
    storage.getState().setEndpointConnectivity({ status: 'online', reason: null, attempt: 0,
      nextRetryAt: null, lastConnectedAt: Date.now(), lastDisconnectedAt: null, lastErrorMessage: null });
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'host', installationId: 'host-installation',
      actionId: 'machines.setup.plan', tokenEpoch: 0, requesterInvocation: 'none', execute: raw => {
        const input = ManagedMachineActionInputSchemasV1['machines.setup.plan'].parse(raw);
        if (!('targets' in input)) throw new Error('Expected the production combined Plan request');
        const target = input.targets[0]!;
        modes.push(target.mode);
        return { targets: [{ homeId: target.homeId, machineId: target.machineId, plan: {
          desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [],
        } }], review: { machineId: 'host', machines: [{ machineId: 'host', online: true }] } };
      } });
    if (outcome === 'unavailable') homes.answer(serverId, 'POST /v1/actions/machines.setup.plan', {
      status: 503, body: { error: 'unavailable' },
    });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({
      id: 'host', installationId: 'host-installation', activeAt: Date.now(),
    })]);
    const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null}
      definitionKind="compose" phone={false} actions={null} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.draft.hostUnchecked')).not.toBeNull());
      expect(screen.findAllByType(MachineSetupRecipeInputs)).toHaveLength(0);
      expect(screen.findAllByType(SoftwareInputFields)).toHaveLength(0);
      expect(screen.findByTestId('project-deployments.draft.hostSetup.prepare')?.props.disabled).toBe(false);
      await screen.pressByTestIdAsync('project-deployments.draft.hostSetup.prepare');
      expect(router.spies.push).toHaveBeenCalledWith(machinePageHref({ door: 'rail',
        target: { machineId: 'host', serverId: serverIdentityId }, tab: { id: 'setup' } }));
      expect(modes).toEqual(outcome === 'unknown' ? [undefined] : []);
    } finally { await screen.unmount(); }
  } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
});

it.each(['satisfied', 'drifted'] as const)('uses the reviewed Docker %s fact after a confirmed setup need', async status => {
  const serverId = await homes.addHome({ name: 'Host facts', serverUrl: `https://deploy-host-${status}.test`,
    accountId: 'alice', serverIdentityId: `srv_${(status === 'satisfied' ? '1' : '2').repeat(32)}`, currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const previous = storage.getState();
  const ref = DEPLOY_HOST_DOCKER_ITEM.selection.ref;
  const key = `${ref.pluginId}/${ref.recipeId}`;
  // The remote daemon's projection and Plan responses are network boundaries.
  // Input rendering, validation, preparation, and the draft consume them through production owners.
  const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
    projection: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
      familiesById: { machineRecipes: { family: 'machineRecipes', entriesById: {
        [key]: { id: key, pluginId: ref.pluginId, pluginVersion: '1', definition: { id: ref.recipeId, ...dockerEngine } },
      } } } } });
  native.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
    ? projection : { ok: false, code: 'unsupported' });
  const modes: unknown[] = [];
  try {
    storage.getState().setEndpointConnectivity({ status: 'online', reason: null, attempt: 0,
      nextRetryAt: null, lastConnectedAt: Date.now(), lastDisconnectedAt: null, lastErrorMessage: null });
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'host', installationId: 'host-installation',
      actionId: 'machines.setup.plan', tokenEpoch: 0, requesterInvocation: 'none', execute: raw => {
        const input = ManagedMachineActionInputSchemasV1['machines.setup.plan'].parse(raw);
        if (!('targets' in input)) throw new Error('Expected the production combined Plan request');
        const target = input.targets[0]!;
        modes.push(target.mode);
        return { targets: [{ homeId: target.homeId, machineId: target.machineId, plan: {
          desiredRevision: 0, sources: target.sources ?? [{ kind: 'direct', setup: { items: [DEPLOY_HOST_DOCKER_ITEM] } }], exclusions: [],
          support: [{ sourceIndex: 0, itemIndex: 0, status: target.mode === 'effects' ? status : 'drifted' }],
          ...(target.mode === 'effects' ? { recipePlans: [] } : {}),
        } }], review: { machineId: 'host', machines: [{ machineId: 'host', online: true }] } };
      } });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({
      id: 'host', installationId: 'host-installation', activeAt: Date.now(),
    })]);
    const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null}
      definitionKind="compose" phone={false} actions={null} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
    try {
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('project-deployments.draft.hostNeedsSetup')).not.toBeNull();
        expect(screen.findAllByType(SoftwareInputFields)).toHaveLength(1);
      });
      // One message for an unready Machine (lab d1d notready): its callout carries the one Review action.
      const callout = screen.findByTestId('project-deployments.draft.hostNeedsSetup')!;
      expect(callout.findAll((node: { props: Record<string, unknown> }) =>
        node.props.testID === 'project-deployments.draft.hostSetup.prepare').length).toBeGreaterThan(0);
      await act(async () => screen.findAllByType(SoftwareInputFields)[0]!.props.onPatch({ daemonConfig: {} }));
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.draft.hostSetup.prepare')?.props.disabled).toBe(false));
      await screen.pressByTestIdAsync('project-deployments.draft.hostSetup.prepare');
      await waitForHomeGovernance(() => expect(modes).toEqual([undefined, 'effects']));
      await waitForHomeGovernance(() => {
        if (status === 'satisfied') {
          expect(screen.findByTestId('project-deployments.draft.hostSetup')).toBeNull();
          expect(screen.findAllByType(MachineSetupRecipeInputs)).toHaveLength(0);
          expect(screen.findByTestId('project-deployments.draft.hostUnchecked')).toBeNull();
        } else {
          expect(screen.findByTestId('project-deployments.draft.hostSetup')).not.toBeNull();
          expect(screen.findAllByType(MachineSetupRecipeInputs)).toHaveLength(1);
        }
      });
    } finally { await screen.unmount(); }
  } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
});
