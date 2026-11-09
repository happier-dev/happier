import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createMachineFixture, flushHookEffects, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentEnvironmentDraft } = await import('./DeploymentEnvironmentDraft');
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { createDeploymentReadControllerV1 } = await import('@happier-dev/deployments');
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
const { storage } = await import('@/sync/domains/state/storageStore');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { PageHeader } = await import('@/components/ui/layout/PageHeader');
const { Item } = await import('@/components/ui/lists/Item');
const { createDeploymentActions } = await import('./deploymentActions');
const { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION } = await import('./deploymentPlatformTargetPlugin.testFixture');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { answerExternalActionAccountForHome } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
const { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreatePreviewV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentTemplateInstantiationPartialV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
const { ProjectSourceRepositorySelectorV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
const repository = ProjectSourceRepositorySelectorV1Schema.parse({
  provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'alice/app', cloneUrl: 'https://github.com/alice/app.git' }, protocol: 'https',
});
await import('@/sync/ops/actions/defaultActionExecutor');

describe('Environment draft Machine Home', () => {
  it('duplicates with explicit binding choices through the creating Action and renders its refusal remedy', async () => {
    const { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1,
      createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const serverId = await homes.addHome({ name: 'Duplicate', serverUrl: 'https://duplicate-environment.test', accountId: 'alice',
      serverIdentityId: `srv_${'a'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, name: 'Staging', bindings: [
      createDeploymentSecretVariableBindingV1({ name: 'KEEP', phase: 'runtime', resourceId: 'saved-a', resourceRevision: 1 }),
      createDeploymentSecretVariableBindingV1({ name: 'EMPTY', phase: 'runtime', resourceId: 'saved-b', resourceRevision: 1 }),
      { purpose: 'variable', name: 'PUBLIC', phase: 'runtime', source: { kind: 'value', value: 'visible' } },
    ] }, targetLinks: [...base.targetLinks.map(row => row.targetLink.role !== 'runtime' ? row : { ...row, targetLink: {
      ...row.targetLink, machines: ['runtime'], members: [{ machineId: 'runtime', installationId: 'runtime-installation', state: 'active' as const }] } }),
    { targetLink: createDeploymentTargetLinkHeaderV1({
      id: 'source-data', role: 'data', targetKind: 'database',
      source: { kind: 'plugin', contribution: { pluginId: 'database', localId: 'database' } },
      machines: [], members: [], machineId: 'runtime', installationId: 'runtime-installation' }), content: {} }] });
    let authored: unknown;
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0, execute: input => {
          authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
          return { ok: false, error: 'deployment_conflict' };
        } });
      // Another answering Machine comes first; a copy still starts on the source's own Machine.
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'elsewhere', installationId: 'elsewhere-installation', activeAt: Date.now() }),
          createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')} copyFrom={detail}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      expect(header().props.titleEditor.value).toBe('Staging copy');
      // The page says what a copy does once, in its header.
      const purpose = header().props.description as string;
      expect(screen.getTextContent().split(purpose).length - 1).toBe(1);
      await screen.pressByTestIdAsync('project-deployments.draft.copy.secret:1:omit');
      // Data comes along by an explicit choice: a new copy starts empty unless the person picks another.
      await screen.pressByTestIdAsync('project-deployments.draft.copy.data:0:restoreBackup');
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, value => value === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value !== undefined);
      expect(authored).toMatchObject({ name: 'Staging copy', copyFrom: {
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        choices: { secrets: [
          { binding: { purpose: 'variable', name: 'KEEP', phase: 'runtime' }, kind: 'useSameReference' },
          { binding: { purpose: 'variable', name: 'EMPTY', phase: 'runtime' }, kind: 'omit' },
        ], values: [{ binding: { purpose: 'variable', name: 'PUBLIC', phase: 'runtime' }, kind: 'include' }],
          data: [{ targetLinkId: 'source-data', kind: 'restoreBackup' }] },
      } });
      expect(authored).not.toHaveProperty('definition');
      expect(authored).toMatchObject({ firstTargetLink: { machines: [{ machineId: 'runtime' }] } });
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.draft.refused'), node => node !== null);
      await screen.pressByTestIdAsync('project-deployments.draft.refused.details');
      expect(screen.getTextContent()).toContain('deployment_conflict');
      // The typed recovery owner's remedy for this refusal, not a draft-local copy.
      const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
      expect(screen.getTextContent()).toContain(readDeploymentRefusalRecoveryV1('deployment_conflict')!.remedy);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('retains a copied Environment after binding failure and recovers only in its variables', async () => {
    const { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1,
      createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const serverId = await homes.addHome({ name: 'Duplicate', serverUrl: 'https://duplicate-environment.test', accountId: 'alice',
      serverIdentityId: `srv_${'a'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, name: 'Staging', bindings: [
      createDeploymentSecretVariableBindingV1({ name: 'KEEP', phase: 'runtime', resourceId: 'saved-a', resourceRevision: 1 }),
      createDeploymentSecretVariableBindingV1({ name: 'EMPTY', phase: 'runtime', resourceId: 'saved-b', resourceRevision: 1 }),
      { purpose: 'variable', name: 'PUBLIC', phase: 'runtime', source: { kind: 'value', value: 'visible' } },
    ] }, targetLinks: [...base.targetLinks, { targetLink: createDeploymentTargetLinkHeaderV1({
      id: 'source-data', role: 'data', targetKind: 'database',
      source: { kind: 'plugin', contribution: { pluginId: 'database', localId: 'database' } },
      machines: [], members: [], machineId: 'runtime', installationId: 'runtime-installation' }), content: {} }] });
    let authored: unknown;
    const saved: unknown[] = [];
    let creates = 0;
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0,
        execute: input => {
          if (typeof input === 'object' && input !== null && 'mode' in input) {
            authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
            const preview = DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview',
              input: { serverId, projectSourceId: 'source-app', requestKey: 'copy-review', protection: 'nonProduction',
                purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'runtime',
                contentArtifactId: 'copied-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
              review: { creationDefaults: { values: { controllerMachineId: 'runtime', buildMachineId: 'runtime', retainPreviousDeployments: 5 },
                sources: { controllerMachineId: 'explicit', buildMachineId: 'builtin', retainPreviousDeployments: 'builtin' } },
                creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 3, projectDefaultsRevision: 0, content: null } } });
            return preview;
          }
          creates++;
          const partial = DeploymentTemplateInstantiationPartialV1Schema.parse({ kind: 'partial', phase: 'bindings',
            errorCode: 'action_forbidden', environmentId: 'copied-environment', revision: 1, savedSecrets: [] });
          return partial;
        }, failure: result => {
          const partial = DeploymentTemplateInstantiationPartialV1Schema.safeParse(result);
          return partial.success ? { errorCode: partial.data.errorCode, error: partial.data.errorCode, details: partial.data } : null;
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')} copyFrom={detail}
        onApprovalRequested={() => {}} onSaved={(...args) => saved.push(args)} onDiscard={() => {}} />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      expect(header().props.titleEditor.value).toBe('Staging copy');
      await screen.pressByTestIdAsync('project-deployments.draft.copy.secret:1:omit');
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, value => value === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value !== undefined);
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, value => value === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => creates, value => value === 1);
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.loading, value => value === false);
      expect(screen.findByTestId('project-deployments.draft.progress')).not.toBeNull();
      expect(screen.getTextContent()).toContain('copied-environment');
      expect(header().props.cancelAction.testID).not.toBe('project-deployments.draft.back');
      await act(async () => header().props.primaryAction.onPress());
      expect(saved).toEqual([['copied-environment', { tab: 'variables' }]]);
      expect(creates).toBe(1);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  beforeEach(async () => {
    await homes.reset();
    // A successful Create selects its Environment in the URL; the next case starts at the collection.
    routerMock.resetParams();
  });
  afterEach(async () => {
    standardCleanup();
    await homes.reset();
    routerMock.resetParams();
  });

  it('withdraws and restores the new Environment entry without withdrawing the collection', async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://deployment-entry.test',
      accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const controller = createDeploymentReadControllerV1({
      scope: { ...account.accountLifetime.scope, projectSourceId: 'source-app' },
      transport: createDeploymentReadTransport(account.accountLifetime),
    });
    try {
      const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
      const { FeaturesResponseSchema } = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
      primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready',
        features: FeaturesResponseSchema.parse({ features: { deployments: { enabled: true } }, capabilities: {} }) } });
      homes.answer(serverId, 'GET /v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
      storage.getState().applySettingsLocal({ featureToggles: { ...storage.getState().settings.featureToggles, deployments: true } });
      const screen = await renderScreen(<ProjectDeploymentsView lifetime={account.accountLifetime} sourceId="source-app"
        controller={controller} demand={{ mounted: true, visible: true, focused: true }} accountId="alice" serverId={serverId}
        actions={createDeploymentActions(account.accountLifetime, 'source-app')} />);
      await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.empty.add'), node => node !== null);
      await act(async () => { storage.getState().applySettingsLocal({
        featureToggles: { ...storage.getState().settings.featureToggles, deployments: false },
      }); });
      expect(screen.findByTestId('project-deployments.empty.add')).toBeNull();
      expect(screen.findByTestId('project-deployments.empty')).not.toBeNull();
      await act(async () => { storage.getState().applySettingsLocal({
        featureToggles: { ...storage.getState().settings.featureToggles, deployments: true },
      }); });
      expect(screen.findByTestId('project-deployments.empty.add')).not.toBeNull();
      await screen.unmount();
    } finally { standardCleanup(); controller.retire(); account.dispose(); storage.setState(previous); }
  });

  it.each([
    { label: 'Project', owner: { kind: 'account' as const, accountId: 'alice' },
      projectDefaults: { buildMachineId: 'project-builder', controllerMachineId: 'project-controller', retainPreviousDeployments: 0 },
      expected: { buildMachineId: 'project-builder', controllerMachineId: 'project-controller', retainPreviousDeployments: 0 } },
    { label: 'own Account fallback', owner: { kind: 'account' as const, accountId: 'alice' }, projectDefaults: null,
      expected: { buildMachineId: 'account-builder', controllerMachineId: 'account-controller', retainPreviousDeployments: 4 } },
    { label: 'Team excludes Account', owner: { kind: 'team' as const, teamId: 'team-a' }, projectDefaults: null,
      expected: { buildMachineId: 'runtime', controllerMachineId: 'runtime', retainPreviousDeployments: 1 } },
  ])('saves using canonical $label defaults without turning runtime selection into placement overrides', async ({ owner, projectDefaults, expected }) => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-defaults.test', accountId: 'alice',
      serverIdentityId: `srv_${'b'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const controller = createDeploymentReadControllerV1({ scope: { ...account.accountLifetime.scope, projectSourceId: 'source-app' },
      transport: createDeploymentReadTransport(account.accountLifetime) });
    let placements: unknown;
    let previewRequests = 0;
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner, audience: [], createdByAccountId: 'alice', repository, defaultRef: 'main',
      } } });
      homes.answer(serverId, 'GET /v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
      // The post-create detail is a separate demand; no Environment content is
      // opened by this authoring/operand-retention test.
      homes.answer(serverId, 'GET /v1/deployments/environments/created-environment', {
        status: 403, body: { ok: false, error: 'deployment_access_denied' },
      });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0,
        additionalMachines: [{ machineId: 'project-controller' }, { machineId: 'account-controller' }],
        execute: (input, { target }) => {
          if (typeof input === 'object' && input !== null && 'mode' in input) {
            const authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
            expect(authored).toMatchObject({ mode: 'preview', name: 'Created app',
              definition: { from: 'repository', ref: 'main', compose: { path: 'compose.yaml' } },
              firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] } });
            expect(authored).not.toHaveProperty('controllerMachineId');
            expect(authored).not.toHaveProperty('buildMachineId');
            expect(authored).not.toHaveProperty('retainPreviousDeployments');
            expect(target).toEqual({ kind: 'machine', machineId: 'runtime' });
            previewRequests++;
            // The daemon response is a genuine system boundary. Its canonical
            // defaults resolution/Team exclusion is exercised by D1's CLI owners.
            const { mode: _mode, name: _name, definition: _definition, firstTargetLink, ...selectors } = authored;
            const source = projectDefaults ? 'project' : owner.kind === 'team' ? 'builtin' : 'account';
            const preview = DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: {
              ...selectors, controllerMachineId: expected.controllerMachineId, buildMachineId: expected.buildMachineId,
              contentArtifactId: `host-prepared-content-${previewRequests}`, contentHeaderVersion: 2, contentBodyVersion: 3,
              firstTargetLink: { ...firstTargetLink, contentArtifactId: `host-prepared-link-${previewRequests}`, contentHeaderVersion: 4, contentBodyVersion: 5 },
            }, review: { creationDefaults: { values: expected, sources: {
              controllerMachineId: source, buildMachineId: source, retainPreviousDeployments: source,
            } }, creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 3,
              projectDefaultsRevision: projectDefaults ? 1 : 0, content: null } } });
            return preview;
          }
          const prepared = DeploymentEnvironmentCreateInputV1Schema.parse(input);
          placements = prepared;
          expect(target).toEqual({ kind: 'machine', machineId: expected.controllerMachineId });
          return { ok: true, environmentId: 'created-environment', revision: 1 };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<ProjectDeploymentsView lifetime={account.accountLifetime} sourceId="source-app"
        controller={controller} demand={{ mounted: true, visible: true, focused: true }}
        accountId="alice" serverId={serverId} actions={createDeploymentActions(account.accountLifetime, 'source-app')} />);
      await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.empty.add'), node => node !== null);
      await screen.pressByTestIdAsync('project-deployments.empty.add');
      await act(async () => screen.findAllByType(PageHeader)[0]!.props.titleEditor.onChangeText('Created app'));
      await waitForTestEvent(screen.subscribe,
        () => screen.findAllByType(PageHeader)[0]!.props.primaryAction.disabled, disabled => disabled === false);
      expect(previewRequests, 'mounting and editing never prepare create Artifacts').toBe(0);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      const sourceWord = { project: 'From the project', account: 'From your Account', builtin: 'Happier’s default' }[
        projectDefaults ? 'project' : owner.kind === 'team' ? 'builtin' : 'account'];
      // Save prepares and shows what the defaults filled in, with where each came from; nothing is created yet.
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(screen.subscribe,
        () => screen.findHostByTestId('project-deployments.draft.defaults'), node => node !== null);
      expect(screen.findHostByTestId('project-deployments.draft.defaults.retention')).not.toBeNull();
      // The review is one sheet: its rows take the group's hairlines like every other section.
      const reviewRows = screen.findAllByType(Item).filter((row) => String(row.props.testID).startsWith('project-deployments.draft.defaults.'));
      expect(reviewRows.map((row) => row.props.showDivider)).toEqual([...reviewRows.slice(1).map(() => true), false]);
      expect(reviewRows.map((row) => [row.props.testID, row.props.subtitle])).toEqual([
        ['project-deployments.draft.defaults.builder', sourceWord],
        ['project-deployments.draft.defaults.controller', sourceWord],
        ['project-deployments.draft.defaults.retention', sourceWord],
      ]);
      expect(screen.getTextContent()).toContain(sourceWord);
      expect(screen.getTextContent()).toContain(expected.retainPreviousDeployments === 0
        ? 'Keeps no previous versions' : `Keeps ${expected.retainPreviousDeployments} previous`);
      expect(placements, 'the prepared run commits only when the person confirms').toBeUndefined();
      // Back drops the prepared run and returns to the editable draft.
      await act(async () => header().props.cancelAction.onPress());
      expect(screen.findHostByTestId('project-deployments.draft.defaults')).toBeNull();
      expect(placements).toBeUndefined();
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(screen.subscribe,
        () => screen.findHostByTestId('project-deployments.draft.defaults'), node => node !== null);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => placements, value => value !== undefined);
      expect(placements).toMatchObject({ controllerMachineId: expected.controllerMachineId, buildMachineId: expected.buildMachineId,
        contentArtifactId: 'host-prepared-content-2', contentHeaderVersion: 2, contentBodyVersion: 3,
        firstTargetLink: { contentArtifactId: 'host-prepared-link-2', contentHeaderVersion: 4, contentBodyVersion: 5,
          machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] } });
      expect(previewRequests, 'each Save prepares once; confirming reuses the retained run').toBe(2);
      expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
      // Request admission precedes Action settlement. Let the confirmed run
      // publish its selected Environment before retiring this case's Home.
      await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.draft'), node => node === null);
      await screen.unmount();
    } finally { standardCleanup(); controller.retire(); account.dispose(); storage.setState(previous); }
  });

  it.each([
    { label: 'keeps the current rule when the person declines', managed: true, choose: 'keep' as const, sent: 'keep' },
    { label: 'offers always on by default', managed: true, choose: null, sent: undefined },
    { label: 'offers nothing for an unmanaged Machine', managed: false, choose: null, sent: undefined },
  ])('retention choice (P41-R31): $label', async ({ managed, choose, sent }) => {
    // A distinct Home per case: the managed inventory is retained per Home for the Account's lifetime.
    const homeId = `srv_${(managed ? (choose ? 'c' : 'd') : 'e').repeat(32)}`;
    const serverId = await homes.addHome({ name: 'Project', serverUrl: `https://draft-retention-${String(managed)}-${choose}.test`,
      accountId: 'alice', serverIdentityId: homeId, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    let authored: Record<string, unknown> | undefined;
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
      const allocation = ManagedMachineV1Schema.parse({ id: 'managed-runtime', homeId, custodianAccountId: 'alice',
        controller: { machineId: 'controller', installationId: 'installed' }, enrolledMachineId: 'runtime',
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Runtime VM', choices: {} },
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now',
        resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        intentRevision: 4, retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true });
      homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: managed ? [allocation] : [] } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0,
        execute: input => {
          authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input) as Record<string, unknown>;
          return { ok: false, error: 'deployment_unavailable' };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('Shop'));
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, disabled => disabled === false);
      const row = 'project-deployments.draft.retention';
      if (managed) {
        await waitForTestEvent(screen.subscribe, () => screen.findHostByTestId(row), node => node !== null);
        expect(screen.findHostByTestId(row), 'a finite managed rule offers the choice').not.toBeNull();
      } else {
        await flushHookEffects({ cycles: 20 });
        expect(screen.findHostByTestId(row), 'nothing to choose for an unmanaged Machine').toBeNull();
      }
      if (choose) await screen.pressByTestIdAsync(`${row}:${choose}`);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value !== undefined);
      expect(authored?.managedRetention).toBe(sent);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it.each([false, true])('authors a stored Compose definition for a repository-free Project (phone=%s)', async (phone) => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-stored.test', accountId: 'alice',
      serverIdentityId: `srv_${'c'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    let authored: unknown;
    const document = 'services:\n  web:\n    image: nginx:alpine\n';
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice' } } });
      homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0, execute: input => {
          authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
          return { ok: false, error: 'deployment_unavailable' };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={phone} actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      const save = () => phone ? screen.findByTestId('project-deployments.draft.save.phone')!.props : header().props.primaryAction;
      await act(async () => header().props.titleEditor.onChangeText('Web'));
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.draft.composeDocument'), node => node !== null);
      expect(save().disabled, 'a stored definition needs the person’s Compose document').toBe(true);
      expect(screen.findByTestId('project-deployments.draft.ref')).toBeNull();
      const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
      const field = () => screen.findAllByType(FieldTextInput).find(node => node.props.testID === 'project-deployments.draft.composeDocument')!;
      await act(async () => field().props.onChangeText(document));
      expect(save().disabled).toBe(false);
      await act(async () => save().onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value !== undefined);
      expect(authored).toMatchObject({ name: 'Web', definition: { from: 'compose', document, profiles: [], services: [] },
        firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] } });
      expect(authored).not.toHaveProperty('definition.ref');
      expect(authored).not.toHaveProperty('definition.compose');
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('starts on an answering Machine, never an unreachable one, and says the typed remedy when the target is unavailable', async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-reachable.test', accountId: 'alice',
      serverIdentityId: `srv_${'r'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
    let authored = false;
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'here', installationId: 'here-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0,
        execute: () => { authored = true; return null; },
        failure: () => ({ errorCode: 'target_unavailable', error: 'target_unavailable' }) });
      const away = createMachineFixture({ id: 'away', installationId: 'away-installation', active: false });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [away, createMachineFixture({ id: 'here', installationId: 'here-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const machine = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'project-deployments.draft.machine')!;
      expect(machine().props.selectedId).toBe('here');
      // Every row says whether its Machine answers, in the presence owner's words; answering ones come first.
      const { describeMachinePresenceLine } = await import('@/utils/sessions/machinePresenceLine');
      const items = machine().props.items as { id: string; subtitle?: string }[];
      expect(items.map(item => item.id)).toEqual(['here', 'away']);
      for (const item of items) {
        const fixture = item.id === 'away' ? away : storage.getState().machines.here ?? null;
        if (fixture) expect(item.subtitle).toBe(describeMachinePresenceLine(fixture, Date.now(), undefined, account.accountLifetime.scope).label);
        expect(item.subtitle).toBeTruthy();
      }
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('Shop'));
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, disabled => disabled === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value);
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.draft.refused'), node => node !== null);
      expect(screen.getTextContent()).toContain(readDeploymentRefusalRecoveryV1('target_unavailable')!.remedy);
      // With only an unreachable Machine left, nothing is chosen for the person.
      await publishMachineInventoryForTest(account.accountLifetime.scope, [away]);
      await waitForTestEvent(screen.subscribe, () => machine().props.selectedId, selected => selected === null);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('creates a platform Environment from the repository alone, with its Machine as controller, then asks to add the platform', async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-platform.test', accountId: 'alice',
      serverIdentityId: `srv_${'f'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    let authored: Record<string, unknown> | undefined;
    let committed: Record<string, unknown> | undefined;
    const saved: Array<[string, unknown]> = [];
    const pluginId = 'com.example.draft-platforms';
    const authoredPlugin = createDeploymentTargetsTestPlugin(pluginId);
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: authoredPlugin.manifest,
      activate: api => authoredPlugin.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
      accountLifetime: account.accountLifetime, publishProjection: true });
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0,
        execute: input => {
          if (typeof input === 'object' && input !== null && 'mode' in input) {
            authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input) as Record<string, unknown>;
            const { mode: _mode, name: _name, definition: _definition, ...selectors } = authored;
            const preview = DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: {
              ...selectors, controllerMachineId: 'runtime', buildMachineId: 'runtime',
              contentArtifactId: 'host-prepared-content', contentHeaderVersion: 2, contentBodyVersion: 3,
            }, review: { creationDefaults: { values: { buildMachineId: 'runtime', controllerMachineId: 'runtime', retainPreviousDeployments: 1 },
              sources: { controllerMachineId: 'explicit', buildMachineId: 'builtin', retainPreviousDeployments: 'builtin' } },
            creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 3, projectDefaultsRevision: 0, content: null } } });
            return preview;
          }
          committed = DeploymentEnvironmentCreateInputV1Schema.parse(input) as Record<string, unknown>;
          return { ok: true, environmentId: 'platform-environment', revision: 1 };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} platformAvailable actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={(id, next) => saved.push([id, next])} onDiscard={() => {}} />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('Marketing site'));
      // Each platform the plugins declare is a choice of its own, beside the person's Machines.
      await waitForTestEvent(screen.subscribe,
        () => screen.findHostByTestId(`project-deployments.draft.target:${pluginId}/beta`), node => node !== null);
      expect(screen.findHostByTestId('project-deployments.draft.target:machine')).not.toBeNull();
      expect(screen.findHostByTestId(`project-deployments.draft.target:${pluginId}/alpha`)).not.toBeNull();
      await screen.pressByTestIdAsync(`project-deployments.draft.target:${pluginId}/beta`);
      // The platform builds the site itself: nothing here asks for a Compose file.
      expect(screen.findHostByTestId('project-deployments.draft.compose')).toBeNull();
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, disabled => disabled === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value !== undefined);
      expect(authored).toMatchObject({ mode: 'preview', definition: { from: 'repository', ref: 'main' }, controllerMachineId: 'runtime' });
      expect(authored?.definition).not.toHaveProperty('compose');
      expect(authored).not.toHaveProperty('firstTargetLink');
      expect(authored).not.toHaveProperty('buildMachineId');
      await waitForTestEvent(screen.subscribe,
        () => screen.findHostByTestId('project-deployments.draft.defaults'), node => node !== null);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => committed, value => value !== undefined);
      expect(committed).not.toHaveProperty('firstTargetLink');
      await waitForTestEvent(screen.subscribe, () => saved.length, count => count > 0);
      // Create carries the chosen platform into its link sheet, so the person never picks it twice.
      expect(saved).toEqual([['platform-environment', { platformTargetKey: `${pluginId}/beta` }]]);
      await screen.unmount();
    } finally { standardCleanup(); await installed.dispose(); account.dispose(); storage.setState(previous); }
  });

  it('offers the way to a platform when no plugin declares one, and says nothing of platforms to a viewer who cannot link', async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-no-platforms.test', accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const { definePlugin } = await import('@happier-dev/plugin-sdk');
    const noTargets = definePlugin({ id: 'com.example.no-deploy-targets', version: '1.0.0', displayName: 'No targets',
      actions: { ping: { title: 'Ping', execution: DEPLOYMENT_TARGETS_TEST_EXECUTION, surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        resultSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => ({}) } } });
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: noTargets.manifest,
      activate: api => noTargets.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
      accountLifetime: account.accountLifetime, publishProjection: true });
    try {
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const draft = (platformAvailable: boolean) => <DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} platformAvailable={platformAvailable} actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />;
      const screen = await renderScreen(draft(true));
      await waitForTestEvent(screen.subscribe,
        () => screen.findHostByTestId('project-deployments.draft.target:plugins'), node => node !== null);
      await screen.pressByTestIdAsync('project-deployments.draft.target:plugins');
      expect(routerMock.spies.push).toHaveBeenCalledWith('/plugins');
      // Leading to Plugins is not a choice: the draft stays on its Machine.
      expect(screen.findHostByTestId('project-deployments.draft.compose')).not.toBeNull();
      await screen.update(draft(false));
      expect(screen.findHostByTestId('project-deployments.draft.target:plugins')).toBeNull();
      await screen.unmount();
    } finally { standardCleanup(); await installed.dispose(); account.dispose(); storage.setState(previous); }
  });

  it('offers and defaults only to the Project Home, retaining that scope when the active Home changes', async () => {
    const activeHome = await homes.addHome({ name: 'Personal', serverUrl: 'https://personal.test', accountId: 'alice' });
    const projectHome = await homes.addHome({ name: 'Project', serverUrl: 'https://project.test', accountId: 'alice', active: false });
    const account = await captureLazyActionAccountContext(projectHome);
    const previous = storage.getState();
    const elsewhere = createMachineFixture({ id: 'personal-machine', installationId: 'personal-installation',
      metadata: { ...createMachineFixture().metadata!, displayName: 'Personal runner' } });
    const projectMachine = createMachineFixture({ id: 'project-machine', installationId: 'project-installation', activeAt: Date.now(),
      metadata: { ...createMachineFixture().metadata!, displayName: 'Project runner' } });
    try {
      await publishMachineInventoryForTest({ serverId: activeHome, accountId: 'alice' }, [elsewhere]);
      await publishMachineInventoryForTest(account.accountLifetime.scope, [projectMachine,
        createMachineFixture({ id: 'revoked', installationId: 'revoked-installation', revokedAt: 1 }),
        createMachineFixture({ id: 'no-installation' }),
      ]);
      await act(async () => storage.setState({ machines: { [elsewhere.id]: elsewhere } }));
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime}
        sourceId="source-app" phone={false} actions={null} onApprovalRequested={() => {}}
        onSaved={() => {}} onDiscard={() => {}} />);
      const picker = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'project-deployments.draft.machine');
      expect(picker()?.props.items).toMatchObject([{ id: projectMachine.id, title: 'Project runner', checked: true }]);
      expect(picker()?.props.items).toHaveLength(1);
      expect(picker()?.props.selectedId).toBe(projectMachine.id);
      // An unrelated active-Home publication must not replace the qualified picker inputs.
      const items = picker()?.props.items;
      await act(async () => storage.setState({ machines: { unrelated: createMachineFixture({ id: 'unrelated', installationId: 'other-installation' }) } }));
      expect(picker()?.props.items).toBe(items);
      expect(picker()?.props.selectedId).toBe(projectMachine.id);
      await act(async () => { await setActiveServerId(projectHome, { scope: 'device' }); });
      await act(async () => { await setActiveServerId(activeHome, { scope: 'device' }); });
      expect(picker()?.props.selectedId).toBe(projectMachine.id);
      const renamed = { ...projectMachine, metadata: { ...projectMachine.metadata!, displayName: 'Renamed project runner' } };
      await act(async () => { await publishMachineInventoryForTest(account.accountLifetime.scope, [renamed]); });
      expect(picker()?.props.items).toMatchObject([{ id: projectMachine.id, title: 'Renamed project runner', checked: true }]);
      await screen.unmount();
    } finally {
      standardCleanup();
      account.dispose();
      storage.setState(previous);
    }
  });
});
