import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createMachineFixture, flushHookEffects, renderScreen, standardCleanup, teamGroupFixture, teamSummaryFixture, teamCapabilitiesFixture, waitForTestEvent } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

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
const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { PageHeader } = await import('@/components/ui/layout/PageHeader');
const { Item } = await import('@/components/ui/lists/Item');
const { createDeploymentActions } = await import('./deploymentActions');
const { DeploymentPlatformInspectState } = await import('./DeploymentPlatformInspectState');
const { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION, answerDeploymentTargetInspectForHome } = await import('./deploymentPlatformTargetPlugin.testFixture');
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
  it.each(['compose', 'image'] as const)('reviews a repository-free Project with its %s Environment only at final confirmation', async kind => {
    const { useDeploymentProjectChoice } = await import('./DeploymentProjectChoice');
    const serverId = await homes.addHome({ name: 'New app', serverUrl: `https://draft-new-project-${kind}.test`, accountId: 'alice',
      serverIdentityId: `srv_${(kind === 'compose' ? 'b' : 'c').repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const authored: Record<string, unknown>[] = [];
    const committed: unknown[] = [];
    const saved: unknown[] = [];
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0, execute: input => {
          if (typeof input === 'object' && input !== null && 'mode' in input) {
            const intent = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
            authored.push(intent);
            const { mode: _mode, name: _name, definition: _definition, firstTargetLink: _link, ...selectors } = intent;
            return DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: { ...selectors,
              controllerMachineId: 'runtime', contentArtifactId: 'reviewed-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
              review: { creationDefaults: { values: { controllerMachineId: 'runtime', retainPreviousDeployments: 1 },
                sources: { controllerMachineId: 'explicit', retainPreviousDeployments: 'builtin' } } } });
          }
          committed.push(DeploymentEnvironmentCreateInputV1Schema.parse(input));
          return { ok: true, environmentId: 'created-environment', projectSourceId: 'created-project', revision: 1 };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      function NewProjectDraft() {
        const projectChoice = useDeploymentProjectChoice({ lifetime: account.accountLifetime, initiallyNew: true });
        return <DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null} projectChoice={projectChoice}
          definitionKind={kind} phone={false} actions={createDeploymentActions(account.accountLifetime)}
          onApprovalRequested={() => {}} onSaved={(id, next) => saved.push([id, next])} onDiscard={() => {}} />;
      }
      const screen = await renderScreen(<NewProjectDraft />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('Status page'));
      const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
      const field = (id: string) => screen.findAllByType(FieldTextInput).find(node => node.props.testID === id)!;
      await act(async () => field('project-deployments.draft.project.newName').props.onChangeText('Operations'));
      if (kind === 'compose') await act(async () => field('project-deployments.draft.composeDocument').props.onChangeText('services:\n  web:\n    image: nginx:stable\n'));
      else {
        await act(async () => field('project-deployments.draft.imageName').props.onChangeText('nginx:stable'));
        await act(async () => field('project-deployments.draft.imagePort').props.onChangeText('80'));
      }
      expect(authored).toEqual([]);
      expect(committed).toEqual([]);
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(header().props.primaryAction.disabled).toBe(false); });
      await act(async () => header().props.primaryAction.onPress());
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(screen.findByTestId('project-deployments.draft.defaults')).not.toBeNull(); });
      expect(authored).toHaveLength(1);
      expect(authored[0]).toMatchObject({ newProject: { name: 'Operations', owner: { kind: 'account', accountId: 'alice' } }, definition: { from: kind } });
      expect(authored[0]).not.toHaveProperty('projectSourceId');
      expect(committed).toEqual([]);
      expect(homes.requests.some(request => request.method === 'POST' && request.path === '/v1/projects/sources')).toBe(false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(saved).toHaveLength(1); });
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({ newProject: authored[0]!.newProject });
      expect(saved).toEqual([['created-environment', { projectSourceId: 'created-project' }]]);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('keeps the Environment draft while adding its first Machine and returns to that exact Machine', async () => {
    const serverId = await homes.addHome({ name: 'Publish', serverUrl: 'https://publish-first-machine.test', accountId: 'alice',
      serverIdentityId: `srv_${'a'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      await publishMachineInventoryForTest(account.accountLifetime.scope, []);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('My app'));
      await screen.pressByTestIdAsync('project-deployments.draft.noMachine.create');
      const { MachineCreationContinuation } = await import('@/components/machines/add/MachineCreationContinuation');
      expect(screen.findAllByType(MachineCreationContinuation)).toHaveLength(1);
      expect(homes.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
      await act(async () => screen.findAllByType(MachineCreationContinuation)[0]!.props.onCancel());
      expect(header().props.titleEditor.value).toBe('My app');
      await screen.pressByTestIdAsync('project-deployments.draft.noMachine.create');
      await act(async () => screen.findAllByType(MachineCreationContinuation)[0]!.props.onDraftChange({
        kind: 'created', serverId, managedId: 'same-paid-resource',
      }));
      await act(async () => screen.findAllByType(MachineCreationContinuation)[0]!.props.onCancel());
      await screen.pressByTestIdAsync('project-deployments.draft.noMachine.create');
      expect(screen.findAllByType(MachineCreationContinuation)[0]!.props.draft).toEqual({
        kind: 'created', serverId, managedId: 'same-paid-resource',
      });
      expect(homes.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
      await act(async () => publishMachineInventoryForTest(account.accountLifetime.scope, [
        createMachineFixture({ id: 'other', installationId: 'other-installation', activeAt: Date.now() }),
        createMachineFixture({ id: 'created', installationId: 'created-installation', activeAt: Date.now() }),
      ]));
      await act(async () => screen.findAllByType(MachineCreationContinuation)[0]!.props.onArrived({ serverId, machineId: 'created' }));
      expect(header().props.titleEditor.value).toBe('My app');
      expect(screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine')?.props.machineId).toBe('created');
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, value => value === false);
      await act(async () => publishMachineInventoryForTest(account.accountLifetime.scope, [
        createMachineFixture({ id: 'other', installationId: 'other-installation', activeAt: Date.now() }),
      ]));
      expect(screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine')?.props.machineId).toBe('created');
      expect(header().props.primaryAction.disabled).toBe(true);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });
  it.each(['team', 'account-shared'] as const)('edits draft deployers through the shared choices and retains them in the creating Action (%s)', async (sourceKind) => {
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
    const { TeamCredentialAudiencePicker } = await import('@/components/settings/teams/credentials/TeamCredentialAudiencePicker');
    const { DeploymentPermissionsPanel } = await import('./DeploymentPermissionsPanel');
    const serverId = await homes.addHome({ name: 'Deployers', serverUrl: `https://draft-deployers-${sourceKind}.test`, accountId: 'alice', teamsEnabled: true,
      serverIdentityId: `srv_${(sourceKind === 'team' ? 'd' : 'e').repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const base = createDeploymentEnvironmentDetailV1();
    // The opened header is also the read path for an agent-authored chosen audience.
    const detail = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment,
      owner: sourceKind === 'team' ? { kind: 'team', teamId: 'team-a' } : { kind: 'account', accountId: 'alice' }, protection: 'production', deployerMode: 'chosen',
      deployerPrincipals: [{ principalKind: 'account', principalId: 'account-ana' },
        { principalKind: 'teamGroup', principalId: 'group-ops' }],
    } });
    const authored: unknown[] = [];
    const createdInputs: ReturnType<typeof DeploymentEnvironmentCreateInputV1Schema.parse>[] = [];
    let savedId: string | null = null;
    try {
      homes.answer(serverId, 'POST /v1/user/profiles', { body: { users: [
        ['alice', 'Alice'], ['account-ana', 'Ana'], ['account-bo', 'Bo'], ['account-cam', 'Cam'], ['account-dee', 'Dee'],
      ].map(([id, name]) => ({ id, name, firstName: name, lastName: null, username: id, avatar: null, bio: null, status: 'none', publicKey: null })) } });
      const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
      const { TeamRefInputV1Schema } = await import('@happier-dev/protocol/teams');
      const teams = [
        teamSummaryFixture({ id: 'team-a', name: 'Platform', capabilities: teamCapabilitiesFixture({}) }),
        teamSummaryFixture({ id: 'team-b', name: 'Release', capabilities: teamCapabilitiesFixture({}) }),
      ];
      const teamRead = bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-a' });
      // Both Teams share one HTTP endpoint; its body selects the acknowledged Team.
      homes.answer(serverId, `${teamRead.method} ${teamRead.path}`, { select: input => {
        const { teamId } = TeamRefInputV1Schema.parse(input);
        const team = teams.find(row => row.id === teamId);
        return team ? { body: team } : { status: 404, body: { error: 'team_not_found' } };
      } });
      const groupRead = bindHomeDomainActionHttpRequestV1('teams.groups.get', { v: 1, teamId: 'team-c', groupId: 'group-shared' });
      homes.answer(serverId, `${groupRead.method} ${groupRead.path}`, { body: teamGroupFixture({ id: 'group-shared', teamId: 'team-c', name: 'Shared operations' }) });
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: detail.environment.owner, audience: sourceKind === 'team' ? [] : [
          { principal: { kind: 'team', teamId: 'team-a' }, level: 'view' },
          { principal: { kind: 'team', teamId: 'team-b' }, level: 'view' },
          { principal: { kind: 'account', accountId: 'account-cam' }, level: 'view' },
          { principal: { kind: 'group', teamId: 'team-c', groupId: 'group-shared' }, level: 'view' },
        ],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0, execute: input => {
          if (typeof input === 'object' && input !== null && 'mode' in input) {
            const intent = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
            authored.push(intent);
            return DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: {
              serverId, projectSourceId: 'source-app', requestKey: intent.requestKey, protection: intent.protection,
              purpose: intent.purpose, deployerMode: intent.deployerMode, deployerPrincipals: intent.deployerPrincipals,
              controllerMachineId: 'runtime', contentArtifactId: 'created-content', contentHeaderVersion: 1, contentBodyVersion: 1,
            }, review: { creationDefaults: { values: { controllerMachineId: 'runtime', buildMachineId: 'runtime', retainPreviousDeployments: 1 },
              sources: { controllerMachineId: 'builtin', buildMachineId: 'builtin', retainPreviousDeployments: 'builtin' } },
              creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 3, projectDefaultsRevision: 0, content: null } } });
          }
          createdInputs.push(DeploymentEnvironmentCreateInputV1Schema.parse(input));
          return { ok: true, environmentId: 'created-environment', revision: 1 };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')} copyFrom={detail}
        onApprovalRequested={() => {}} onSaved={id => { savedId = id; }} onDiscard={() => {}} />);
      const prefix = 'project-deployments.environment.permissions';
      const deployers = () => screen.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === `${prefix}.deployers`);
      expect(deployers()).toBeDefined();
      await waitForTestEvent(screen.subscribe, () => screen.findAllByType(TeamCredentialAudiencePicker)[0], node => node !== undefined);
      expect(deployers()?.props.value).toBe('chosen');
      expect(screen.findByTestId(`${prefix}.chosen.account.account-ana`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${prefix}.chosen.account.account-ana.remove`);
      await act(async () => screen.findAllByType(TeamCredentialAudiencePicker)[0]!.props.onChoose({
        kind: 'member', id: 'membership-bo', accountId: 'account-bo', name: 'Bo',
      }));
      await act(async () => screen.findAllByType(TeamCredentialAudiencePicker)[0]!.props.onChoose({
        kind: 'group', id: 'group-release', name: 'Release',
      }));
      const expectedPrincipals = [
        { principalKind: 'teamGroup', principalId: 'group-ops' }, { principalKind: 'account', principalId: 'account-bo' },
        { principalKind: 'teamGroup', principalId: 'group-release' },
      ];
      if (sourceKind === 'account-shared') {
        expect(screen.findAllByType(TeamCredentialAudiencePicker).map(node => node.props.address.teamId)).toEqual(['team-a', 'team-b']);
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        const { getTeamSnapshot } = await import('@/sync/store/teams/teamsSnapshots');
        const credential = await resolveServerCredentialAccountScope(account.accountLifetime.scope.serverId);
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          const snapshots = ['team-a', 'team-b'].map(teamId => {
            const snapshot = getTeamSnapshot(account.accountLifetime.scope, { serverId: account.accountLifetime.scope.serverId, teamId });
            return { teamId, status: snapshot?.status, error: snapshot?.error, name: snapshot?.data?.name };
          });
          const diagnostic = { credential: credential.kind === 'bound' ? { kind: credential.kind, scope: credential.scope } : { kind: credential.kind },
            snapshots, requests: homes.requests.map(({ method, path }) => ({ method, path })) };
          expect(screen.findAllByType(TeamCredentialAudiencePicker).map(node => node.props.label), JSON.stringify(diagnostic))
            .toEqual([expect.stringContaining('Platform'), expect.stringContaining('Release')]);
        });
        const choiceTitle = (id: string) => screen.findAllByType(Item).find(node => node.props.testID === id)?.props.title;
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(choiceTitle(`${prefix}.chosen.add.account.account-cam`)).toBe('Cam');
        });
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(choiceTitle(`${prefix}.chosen.add.teamGroup.group-shared`)).toBe('Shared operations');
        });
        await screen.pressByTestIdAsync(`${prefix}.chosen.add.account.account-cam`);
        await screen.pressByTestIdAsync(`${prefix}.chosen.add.teamGroup.group-shared`);
        await act(async () => screen.findAllByType(TeamCredentialAudiencePicker)[1]!.props.onChoose({
          kind: 'member', id: 'membership-dee', accountId: 'account-dee', name: 'Dee',
        }));
        expectedPrincipals.push({ principalKind: 'account', principalId: 'account-cam' },
          { principalKind: 'teamGroup', principalId: 'group-shared' }, { principalKind: 'account', principalId: 'account-dee' });
      }
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, value => value === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored.length, value => value === 1);
      expect(authored[0]).toMatchObject({ deployerMode: 'chosen', protection: 'production', deployerPrincipals: expectedPrincipals });
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.loading, value => value === false);
      await act(async () => deployers()!.props.onChange('members'));
      await screen.pressByTestIdAsync('project-deployments.draft.production');
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored.length, value => value === 2);
      expect(authored[1]).toMatchObject({ deployerMode: 'members', protection: 'nonProduction' });
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.loading, value => value === false);
      await act(async () => deployers()!.props.onChange('chosen'));
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored.length, value => value === 3);
      expect(authored[2]).toMatchObject({ deployerMode: 'chosen', protection: 'nonProduction', deployerPrincipals: expectedPrincipals });
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.loading, value => value === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(screen.subscribe, () => savedId, value => value === 'created-environment');
      expect(createdInputs).toMatchObject([{ deployerMode: 'chosen', protection: 'nonProduction', deployerPrincipals: expectedPrincipals }]);
      await screen.unmount();
      const created = createdInputs[0];
      if (!created) throw new Error('missing_created_environment');
      const createdHeader = { ...detail.environment, id: 'created-environment', serverId, projectSourceId: 'source-app',
        deployerMode: created.deployerMode, deployerPrincipals: created.deployerPrincipals, protection: created.protection,
        contentArtifactId: created.contentArtifactId, contentHeaderVersion: created.contentHeaderVersion, contentBodyVersion: created.contentBodyVersion };
      const { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DeploymentEnvironmentDetailV1Schema } = await import('@happier-dev/deployment-protocol/v1');
      await account.createArtifactDocument({ artifactId: createdHeader.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }, body: JSON.stringify(detail.content) });
      // The real reader parses the server's persisted header and opens its Artifact before the panel consumes it.
      homes.answer(serverId, 'GET /v1/deployments/environments/created-environment', { body: {
        ok: true, environment: createdHeader, targetLinks: [],
      } });
      const read = await createDeploymentReadTransport(account.accountLifetime).readEnvironment(
        { ...account.accountLifetime.scope, projectSourceId: 'source-app' }, 'created-environment', { signal: new AbortController().signal });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.failure.code);
      // The mounted Environment panel reads the Account's settings scope from the app store.
      storage.setState({ settingsScope: account.accountLifetime.scope });
      const panel = await renderScreen(<DeploymentPermissionsPanel detail={{ ...DeploymentEnvironmentDetailV1Schema.parse(read.value), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] }}
        lifetime={account.accountLifetime} machineName={id => id} onOpenController={() => {}} editing={{ actions: createDeploymentActions(account.accountLifetime, 'source-app'),
          serverId, review: { pendingId: null, request: () => {}, open: () => {} }, onChanged: () => {} }} />);
      expect(panel.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === `${prefix}.deployers`)?.props.value).toBe('chosen');
      expect(panel.findByTestId(`${prefix}.chosen.account.account-bo`)).not.toBeNull();
      expect(panel.findByTestId(`${prefix}.chosen.teamGroup.group-release`)).not.toBeNull();
      if (sourceKind === 'account-shared') {
        expect(panel.findAllByType(TeamCredentialAudiencePicker).map(node => node.props.address.teamId)).toEqual(['team-a', 'team-b']);
        expect(panel.findByTestId(`${prefix}.chosen.account.account-cam`)).not.toBeNull();
        expect(panel.findByTestId(`${prefix}.chosen.teamGroup.group-shared`)).not.toBeNull();
        expect(panel.findByTestId(`${prefix}.chosen.account.account-dee`)).not.toBeNull();
        const savedTitle = (id: string) => panel.findAllByType(Item).find(node => node.props.testID === id)?.props.title;
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(savedTitle(`${prefix}.chosen.account.account-dee`)).toBe('Dee');
        });
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(savedTitle(`${prefix}.chosen.teamGroup.group-shared`)).toBe('Shared operations');
        });
      }
      await panel.unmount();
      const fresh = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={null} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      expect(fresh.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === `${prefix}.deployers`)?.props.value).toBe('managers');
      await fresh.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });
  it.each(['omit', 'reuse'] as const)('duplicates with explicit binding and data choices through the creating Action and renders its refusal remedy (%s)', async (dataChoice) => {
    const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
    const { Switch } = await import('@/components/ui/forms/Switch');
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
      const dataRow = () => screen.findAllByType(SegmentedChoiceItem).find(node => node.props.testIDPrefix === 'project-deployments.draft.copy.data:0');
      expect(dataRow()?.props.value).toBe('omit');
      // Provisioning is explicit; the person can also return to leaving data unattached.
      await screen.pressByTestIdAsync('project-deployments.draft.copy.data:0:createEmpty');
      await screen.pressByTestIdAsync('project-deployments.draft.copy.data:0:omit');
      expect(dataRow()?.props.value).toBe('omit');
      if (dataChoice === 'reuse') {
        await screen.pressByTestIdAsync('project-deployments.draft.copy.data:0:reuse');
        expect(header().props.primaryAction.disabled).toBe(true);
        await act(async () => screen.findAllByType(Switch).find(node => node.props.testID === 'project-deployments.draft.copy.data:0:binding:runtime:KEEP')!.props.onValueChange(true));
        expect(header().props.primaryAction.disabled).toBe(false);
        await screen.pressByTestIdAsync('project-deployments.draft.copy.secret:0:omit');
        expect(header().props.primaryAction.disabled).toBe(true);
        await screen.pressByTestIdAsync('project-deployments.draft.copy.secret:0:useSameReference');
        expect(header().props.primaryAction.disabled).toBe(true);
        await act(async () => screen.findAllByType(Switch).find(node => node.props.testID === 'project-deployments.draft.copy.data:0:binding:runtime:KEEP')!.props.onValueChange(true));
      }
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, value => value === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value !== undefined);
      expect(authored).toMatchObject({ name: 'Staging copy', copyFrom: {
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        choices: { secrets: [
          { binding: { purpose: 'variable', name: 'KEEP', phase: 'runtime' }, kind: 'useSameReference' },
          { binding: { purpose: 'variable', name: 'EMPTY', phase: 'runtime' }, kind: 'omit' },
        ], values: [{ binding: { purpose: 'variable', name: 'PUBLIC', phase: 'runtime' }, kind: 'include' }],
          data: [dataChoice === 'omit' ? { targetLinkId: 'source-data', kind: 'omit' } : {
            targetLinkId: 'source-data', kind: 'reuse', bindings: [{ purpose: 'variable', name: 'KEEP', phase: 'runtime' }],
          }] },
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
    homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
      id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [], createdByAccountId: 'alice',
    } } });
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

  it('authors a Run an image definition in the same draft when the door asks for one', async () => {
    const serverId = await homes.addHome({ name: 'Image', serverUrl: 'https://image-definition.test', accountId: 'alice',
      serverIdentityId: `srv_${'f'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    try {
      let authored: ReturnType<typeof DeploymentEnvironmentCreateIntentInputV1Schema.parse> | undefined;
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository } } });
      homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0, execute: input => {
          authored = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
          return { ok: false, error: 'deployment_unavailable' };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app" definitionKind="image"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
      const field = (testID: string) => screen.findAllByType(FieldTextInput).find(node => node.props.testID === testID)!;
      await act(async () => header().props.titleEditor.onChangeText('Web'));
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.draft.imageName'), node => node !== null);
      expect(screen.findByTestId('project-deployments.draft.ref'), 'an image definition needs no repository, even in a repository Project').toBeNull();
      expect(header().props.primaryAction.disabled).toBe(true);
      await act(async () => field('project-deployments.draft.imageName').props.onChangeText('ghcr.io/acme/web:1'));
      await act(async () => field('project-deployments.draft.imagePort').props.onChangeText('not a port'));
      expect(header().props.primaryAction.disabled, 'the port must be a real port').toBe(true);
      await act(async () => field('project-deployments.draft.imagePort').props.onChangeText('8080'));
      expect(header().props.primaryAction.disabled).toBe(false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value !== undefined);
      expect(authored).toMatchObject({ name: 'Web', definition: { from: 'image', image: 'ghcr.io/acme/web:1', port: 8080 } });
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('starts on the Machine a Deploy an app here door names, not the first one that answers', async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-door-machine.test', accountId: 'alice',
      serverIdentityId: `srv_${'q'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [
        createMachineFixture({ id: 'first', installationId: 'first-installation', activeAt: Date.now() }),
        createMachineFixture({ id: 'chosen', installationId: 'chosen-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')} initialMachineId="chosen"
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const machine = () => screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine')!;
      expect(machine().props.machineId).toBe('chosen');
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
      const machine = () => screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine')!;
      expect(machine().props.machineId).toBe('here');
      // Both are offered through New Session's Machine picker, which says each one's presence; the away one stays choosable.
      expect((machine().props.machines as { id: string }[]).map(row => row.id).sort()).toEqual(['away', 'here']);
      expect(machine().props.awayMachinesChoosable).toBe(true);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('Shop'));
      await waitForTestEvent(screen.subscribe, () => header().props.primaryAction.disabled, disabled => disabled === false);
      await act(async () => header().props.primaryAction.onPress());
      await waitForTestEvent(homes.subscribe, () => authored, value => value);
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.draft.refused'), node => node !== null);
      expect(screen.getTextContent()).toContain(readDeploymentRefusalRecoveryV1('target_unavailable')!.remedy);
      // With only an unreachable Machine left, nothing is chosen for the person.
      await publishMachineInventoryForTest(account.accountLifetime.scope, [away]);
      await waitForTestEvent(screen.subscribe, () => machine().props.machineId, selected => selected === null);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('never defaults to an answering Machine whose Deployments role is off (Machine roles)', async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-roles.test', accountId: 'alice',
      serverIdentityId: `srv_${'q'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
      const parkedBase = createMachineFixture({ id: 'a-parked', installationId: 'parked-installation', activeAt: Date.now() });
      const parked = { ...parkedBase, metadata: { ...parkedBase.metadata!, rolesV1: { active: ['sessions'] } } };
      const deployer = createMachineFixture({ id: 'z-deployer', installationId: 'deployer-installation', activeAt: Date.now() - 1_000 });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [parked, deployer]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const machine = () => screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine')!;
      // The Deployments-off Machine is listed and answers; it must still not be the default.
      expect((machine().props.machines as { id: string }[]).map(row => row.id)).toContain('a-parked');
      expect(machine().props.machineId).toBe('z-deployer');
      // With only the Deployments-off Machine, nothing is chosen for the person.
      await publishMachineInventoryForTest(account.accountLifetime.scope, [parked]);
      await waitForTestEvent(screen.subscribe, () => machine().props.machineId, selected => selected === null);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it.each([[false, false], [true, false], [false, true]])('configures and inspects a platform before Save, then preserves the reviewed choice (link refusal: %s; target disappears: %s)', async (linkRefused, targetDisappears) => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://draft-platform.test', accountId: 'alice',
      serverIdentityId: `srv_${'f'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    let authored: Record<string, unknown> | undefined;
    let committed: Record<string, unknown> | undefined;
    let linkedArtifact: string | undefined;
    const saved: Array<[string, unknown]> = [];
    const pluginId = 'com.example.draft-platforms';
    const awaitImportSchemas = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const inspections: unknown[] = [];
    const authoredPlugin = createDeploymentTargetsTestPlugin(pluginId, async (_target, input) => { inspections.push(input); });
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: authoredPlugin.manifest,
      activate: api => authoredPlugin.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
      accountLifetime: account.accountLifetime, publishProjection: true });
    const receiver = await answerDeploymentTargetInspectForHome({ homes, serverId, accountId: 'alice', machineId: 'runtime', plugin: authoredPlugin });
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
      const { createDeploymentEnvironmentHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
      homes.answer(serverId, 'GET /v1/deployments/environments/platform-environment', { body: { ok: true,
        environment: createDeploymentEnvironmentHeaderV1({ id: 'platform-environment', projectSourceId: 'source-app',
          serverId: `srv_${'f'.repeat(32)}`, controllerMachineId: 'runtime' }), targetLinks: [] } });
      homes.answer(serverId, 'POST /v1/deployments/targets/list', {
        body: { ok: true, items: [], nextCursor: null, coverage: 'complete' } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.targets.link', tokenEpoch: 0, execute: input => {
          const { DeploymentActionInputSchemasV1 } = awaitImportSchemas;
          const link = DeploymentActionInputSchemasV1['deployments.targets.link'].parse(input);
          if (!('contentArtifactId' in link)) throw new Error('Expected the canonical protected link content');
          linkedArtifact = link.contentArtifactId;
          expect(link).toMatchObject({ environmentId: 'platform-environment', expectedRevision: 1,
            source: { kind: 'plugin', contribution: { pluginId, localId: 'beta' } } });
          return linkRefused ? { ok: false, error: 'deployment_conflict' }
            : { ok: true, environmentId: 'platform-environment', revision: 2, targetLinkId: 'platform-link', targetLinkRevision: 1 };
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const draftOwner = { refresh: () => {} };
      function DraftOwner() {
        const [lifetime, setLifetime] = React.useState(account.accountLifetime);
        draftOwner.refresh = () => setLifetime({ ...account.accountLifetime });
        return <DeploymentEnvironmentDraft lifetime={lifetime} sourceId="source-app"
          phone={false} platformAvailable actions={createDeploymentActions(account.accountLifetime, 'source-app')}
          onApprovalRequested={() => {}} onSaved={(id, next) => saved.push([id, next])} onDiscard={() => {}} />;
      }
      const screen = await renderScreen(<DraftOwner />);
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('Marketing site'));
      // Each platform the plugins declare is a choice of its own, beside the person's Machines.
      await waitForTestEvent(screen.subscribe,
        () => screen.findHostByTestId(`project-deployments.draft.target:${pluginId}/beta`), node => node !== null);
      expect(screen.findHostByTestId('project-deployments.draft.target:machine')).not.toBeNull();
      expect(screen.findHostByTestId(`project-deployments.draft.target:${pluginId}/alpha`)).not.toBeNull();
      await screen.pressByTestIdAsync(`project-deployments.draft.target:${pluginId}/beta`);
      // Owner feedback 2026-11-10: the real choices and preparation are inline before any creation.
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
      expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(1);
      expect(authored).toBeUndefined();
      await act(async () => screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account',
        account: { service: { pluginId: 'com.example.cloud', localId: 'cloud-account' }, accountId: 'cloud-account' } }));
      const patch = async (value: Record<string, unknown>) => act(async () => screen.findAllByType(ActionInputFields)[0]!.props.onPatch(value));
      await patch({ beta: 'beta-west' });
      await patch({ providerAccountId: 'cloud' });
      await patch({ providerEnvironment: { kind: 'production' } });
      await screen.pressByTestIdAsync('project-deployments.platform.check');
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(inspections, JSON.stringify({ outcome: screen.findAllByType(DeploymentPlatformInspectState).map(node => node.props.outcome), screen: screen.getTextContent(), requests: homes.requests.map(({ method, path }) => ({ method, path })) })).toHaveLength(1);
      });
      expect(inspections[0]).not.toHaveProperty('environmentId');
      expect(inspections[0]).not.toHaveProperty('expectedRevision');
      expect(authored).toBeUndefined();
      // The platform builds the site itself: nothing here asks for a Compose file.
      expect(screen.findHostByTestId('project-deployments.draft.compose')).toBeNull();
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(header().props.primaryAction.disabled, screen.getTextContent()).toBe(false); });
      if (targetDisappears) {
        // Disabling the admitted release removes its declarations on the next owner refresh.
        // Unloading the executable alone does not withdraw the Account's declared target.
        await act(async () => { installed.disable(); draftOwner.refresh(); });
        await waitForHomeGovernance(async () => { await act(async () => {});
          expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(0); });
        const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
        expect(screen.findAllByType(SelectionTiles)[0]!.props.value).toBe(`${pluginId}/beta`);
        expect(header().props.primaryAction.disabled).toBe(true);
        await act(async () => header().props.primaryAction.onPress());
        expect(authored).toBeUndefined();
        expect(committed).toBeUndefined();
        await screen.unmount();
        return;
      }
      await act(async () => header().props.primaryAction.onPress());
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(authored, screen.getTextContent()).toBeDefined(); });
      expect(authored).toMatchObject({ mode: 'preview', definition: { from: 'repository', ref: 'main' }, controllerMachineId: 'runtime' });
      expect(authored?.definition).not.toHaveProperty('compose');
      expect(authored).not.toHaveProperty('firstTargetLink');
      expect(authored).not.toHaveProperty('buildMachineId');
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findHostByTestId('project-deployments.draft.defaults'), screen.getTextContent()).not.toBeNull(); });
      await act(async () => header().props.primaryAction.onPress());
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(committed, screen.getTextContent()).toBeDefined(); });
      expect(committed).not.toHaveProperty('firstTargetLink');
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(linkedArtifact, screen.getTextContent()).toBeDefined(); });
      await act(async () => {});
      expect(linkedArtifact).toBeTruthy();
      const linkedContent = await account.readArtifactContent(linkedArtifact!);
      if (!linkedContent || typeof linkedContent.body !== 'string') throw new Error('Expected the saved link as a text Artifact');
      expect(linkedContent.header).toMatchObject({ kind: 'deployment-target-link.v1' });
      expect(JSON.parse(linkedContent.body)).toEqual({
          credentialPrincipal: { kind: 'account', accountId: 'alice',
            purpose: { consumer: { pluginId, localId: 'inspect-beta' }, purpose: 'beta.manage' },
            target: { kind: 'account', account: { service: { pluginId: 'com.example.cloud', localId: 'cloud-account' }, accountId: 'cloud-account' } } },
          providerIdentity: { providerAccountId: 'cloud', providerResourceId: 'beta-west', providerEnvironment: 'production' },
          providerEnvironment: { kind: 'production' },
      });
      // Save never re-runs inspection or substitutes the association: the retained provider result is the content.
      expect(inspections).toHaveLength(1);
      if (!linkRefused) {
        // The agent front door accepts the person's draft, and returns the provider content the UI saved.
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const inspect = () => execute('action.invoke', {
          action: { pluginId, localId: 'inspect-beta' }, input: inspections[0],
        }, { surface: 'cli', serverId, expectedAccountId: 'alice' });
        const { PluginProjectionV2Schema, PluginProjectedActionV2Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
          actionsById: Object.fromEntries(authoredPlugin.manifest.contributes.actions.map(action =>
            [`${pluginId}/${action.id}`, {
              ...Object.fromEntries(Object.entries(action).filter(([key]) => Object.hasOwn(PluginProjectedActionV2Schema.shape, key))),
              pluginId, occurrenceId: 'runtime-plugin:1', available: true,
            }])) });
        const rpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        const { answerMachineProjectionDescribeAtRpcBoundary } = await import('@/dev/testkit/mocks/machineProjectionRpc');
        const describe = answerMachineProjectionDescribeAtRpcBoundary(machineId => {
          expect(machineId).toBe('runtime');
          return { supported: true, projection };
        });
        const receiverProjection = vi.spyOn(rpc, 'machineRpcWithServerScope')
          .mockImplementation(async <R, A>(params: Parameters<typeof rpc.machineRpcWithServerScope<R, A>>[0]): Promise<R> =>
            // The RPC boundary's generic payload is validated by the real projection reader.
            await describe(params) as R);
        try {
          // Automatic Account placement needs an own receiver, unlike the UI's explicit target.
          expect(await inspect()).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
          const runtime = createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() });
          const access = { custodian: { accountId: 'other-account', displayName: 'Other owner' },
            role: 'manage' as const, resourceMode: 'plain' as const, accessState: 'ready' as const };
          await publishMachineInventoryForTest(account.accountLifetime.scope, [{ ...runtime, access }]);
          expect(await inspect()).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
          await publishMachineInventoryForTest(account.accountLifetime.scope,
            [{ ...runtime, access: { ...access, custodian: { accountId: 'alice', displayName: 'Alice' } } }]);
          expect(await inspect()).toMatchObject({ ok: true, result: JSON.parse(linkedContent.body) });
        } finally { receiverProjection.mockRestore(); }
      }
      if (linkRefused) {
        expect(saved).toEqual([]);
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.draft.refused'), node => node !== null);
        await act(async () => header().props.primaryAction.onPress());
        expect(saved).toEqual([['platform-environment', { tab: 'settings' }]]);
      } else {
        expect(saved).toEqual([['platform-environment', undefined]]);
      }
      await screen.unmount();
    } finally { standardCleanup(); await receiver.dispose(); await installed.dispose(); account.dispose(); storage.setState(previous); }
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
      const picker = () => screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine');
      expect((picker()?.props.machines as { id: string }[]).map(row => row.id)).toEqual([projectMachine.id]);
      expect(picker()?.props.machineId).toBe(projectMachine.id);
      expect(screen.getTextContent()).toContain('Project runner');
      // An unrelated active-Home publication must not replace the qualified picker inputs.
      const machines = picker()?.props.machines;
      await act(async () => storage.setState({ machines: { unrelated: createMachineFixture({ id: 'unrelated', installationId: 'other-installation' }) } }));
      expect(picker()?.props.machines).toBe(machines);
      expect(picker()?.props.machineId).toBe(projectMachine.id);
      await act(async () => { await setActiveServerId(projectHome, { scope: 'device' }); });
      await act(async () => { await setActiveServerId(activeHome, { scope: 'device' }); });
      expect(picker()?.props.machineId).toBe(projectMachine.id);
      const renamed = { ...projectMachine, metadata: { ...projectMachine.metadata!, displayName: 'Renamed project runner' } };
      await act(async () => { await publishMachineInventoryForTest(account.accountLifetime.scope, [renamed]); });
      expect(picker()?.props.machineId).toBe(projectMachine.id);
      expect(screen.getTextContent()).toContain('Renamed project runner');
      await screen.unmount();
    } finally {
      standardCleanup();
      account.dispose();
      storage.setState(previous);
    }
  });
});
