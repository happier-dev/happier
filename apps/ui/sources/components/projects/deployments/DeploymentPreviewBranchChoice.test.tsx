import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin, PluginError, DeploymentTargetRoleInputProtocolSchemasV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString, defineProtocolArray } from '@happier-dev/plugin-sdk/protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover'))
  .createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { createDeploymentActions } = await import('./deploymentActions');
const { DeploymentPreviewBranchChoice } = await import('./DeploymentPreviewBranchChoice');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
afterEach(standardCleanup);

it('reads a parent only on selection, settles a provider refusal, retries explicitly and saves intent without creating a branch', async () => {
  const pluginId = 'com.example.preview-database';
  const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;
  const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
  const str = defineProtocolString();
  const output = defineProtocolObject({ branches: defineProtocolArray(defineProtocolObject({ providerProjectId: str, branchId: str, name: str }, { policy: 'closed' })), nextCursor: str.optional() }, { policy: 'closed' });
  let reads = 0;
  let mutations = 0;
  let refuse = () => {};
  const pending = new Promise<void>(resolve => { refuse = resolve; });
  const read = { title: 'List database parents', execution, surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
    inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['branches.list'], resultSchema: output,
    run: async () => { reads++; if (reads === 1) { await pending; throw new PluginError({ code: 'credential_unavailable' }); }
      if (reads === 2) return { branches: [], nextCursor: 'next-parents' };
      return { branches: [{ providerProjectId: 'project', branchId: 'main', name: 'Production' }] }; } } as const;
  const write = { ...read, readOnly: false, dangerLevel: 'writesRemote', confirmation: { title: 'Change database?' },
    run: async () => { mutations++; return { branches: [] }; } } as const;
  // A real third-party data contribution exercises declaration discovery, Action dispatch and schema admission.
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Preview database',
    actions: { parents: read, create: write, remove: { ...write, dangerLevel: 'destructive' } },
    deploymentTargets: { database: { role: 'data', title: 'Database', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, dataV1: { branches: { listAction: 'parents', create: 'create', delete: 'remove' } } } } });
  const serverId = await homes.addHome({ name: 'Preview database', serverUrl: 'https://preview-parent.test',
    serverIdentityId: 'srv_preview_database', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
  const link = createDeploymentTargetLinkHeaderV1({ id: 'data-link', role: 'data', targetKind: 'database', machines: [], members: [],
    source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } } });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: account.accountLifetime.scope.serverId }),
    targetLinks: [{ targetLink: link, content: {
      providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' },
      providerEnvironment: { kind: 'custom', id: 'main' }, credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'database.manage' },
        target: { kind: 'account', account: { service: { pluginId, localId: 'database' }, accountId: 'token' } } },
    } }] });
  await account.createArtifactDocument({ artifactId: link.contentArtifactId,
    header: { kind: 'deployment-target-link.v1', title: 'Customer database' }, body: JSON.stringify(detail.targetLinks[0]!.content) });
  type Data = NonNullable<typeof detail.content.previewTemplate>['data'];
  const saved: Data[] = [];
  await answerExternalActionAccountForHome(homes, serverId, {
    machineId: detail.environment.controllerMachineId, actionId: 'action.invoke', tokenEpoch: 0,
    requesterInvocation: 'required', execute: async raw => {
      const invocation = getActionSpec('action.invoke').inputSchema.parse(raw);
      expect(invocation.action).toEqual({ pluginId, localId: 'parents' });
      const input = DeploymentTargetRoleInputProtocolSchemasV1['branches.list'].parse(invocation.input);
      if (reads === 2) expect(input.cursor).toBe('next-parents');
      // Controller HTTP and the provider are the boundary; placement, custody and Action admission stay real.
      try { return output.parse(await read.run()); }
      catch (error) { if (error instanceof PluginError) return { errorCode: error.code, error: error.code }; throw error; }
    },
    failure: result => typeof result === 'object' && result !== null && 'errorCode' in result
      ? { errorCode: String(result.errorCode), error: String(result.errorCode) } : null,
  });
  const readsBeforeOpen = homes.requestsFor('/v1/artifacts/read').length;
  const screen = await renderScreen(<DeploymentPreviewBranchChoice detail={detail} lifetime={account.accountLifetime}
    inspect={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId).inspectPlatformTarget}
    saving={false} onSave={data => saved.push(data)} testID="preview.branch" />);
  try {
    const picker = () => screen.root.findByType(DropdownMenu);
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(picker().props.items).toHaveLength(1); });
    const artifactReads = () => homes.requestsFor('/v1/artifacts/read').length;
    expect(artifactReads()).toBe(readsBeforeOpen);
    await act(async () => picker().props.onOpenChange(true));
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(picker().props.items[0].title).toBe('Customer database'); });
    expect(reads).toBe(0);
    await act(async () => picker().props.onSelect(link.id));
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(reads).toBe(1); });
    // The picker holds while the parent is read, in place.
    expect(picker().props.itemTrigger.itemProps.disabled).toBe(true);
    expect(saved).toEqual([]);
    await act(async () => refuse());
    const failure = () => screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'preview.branch.failed');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(failure()?.props.diagnosticCode).toBe('credential_unavailable'); });
    await act(async () => failure()!.props.action.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(failure()?.props.diagnosticCode).toBeUndefined();
      expect(reads).toBe(3);
      expect(saved).toEqual([[{ kind: 'managed', dataTargetLinkId: link.id,
      ownership: 'providerNative', parentBranchRef: { providerProjectId: 'project', branchId: 'main', displayName: 'Production' } }]]); });
    expect(screen.root.findAllByType(SurfaceStateCard).some(node => node.props.testID === 'preview.branch.next')).toBe(false);
    detail.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
      runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: saved[0]! };
    await act(async () => screen.update(<DeploymentPreviewBranchChoice key="reloaded" detail={JSON.parse(JSON.stringify(detail))}
      lifetime={account.accountLifetime}
      inspect={createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId).inspectPlatformTarget}
      saving={false} onSave={data => saved.push(data)} testID="preview.branch" />));
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(picker().props.itemTrigger.detailFormatter()).toBe('Customer database · Production'); });
    expect(reads).toBe(3);
    expect(mutations).toBe(0);
  } finally { await screen.unmount(); await installed.dispose(); account.dispose(); await homes.reset(); }
});
