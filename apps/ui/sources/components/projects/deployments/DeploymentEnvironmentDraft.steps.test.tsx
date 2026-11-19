import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  act,
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
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
const { DeploymentEnvironmentDraft } =
  await import('./DeploymentEnvironmentDraft');
type DeploymentDraftFrame =
  import('./DeploymentEnvironmentDraft').DeploymentDraftFrame;
const { useDeploymentProjectChoice } =
  await import('./DeploymentProjectChoice');
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { publishMachineInventoryForTest } =
  await import('@/dev/testkit/harness/machinePresence');
const { storage } = await import('@/sync/domains/state/storageStore');
const { PageHeader } = await import('@/components/ui/layout/PageHeader');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
const { SetupSteps } = await import('@/components/ui/setupBlocks/SetupSteps');
const { createDeploymentActions } = await import('./deploymentActions');
const { answerExternalActionAccountForHome } =
  await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
const {
  DeploymentEnvironmentCreateInputV1Schema,
  DeploymentEnvironmentCreatePreviewV1Schema,
  DeploymentEnvironmentCreateIntentInputV1Schema,
} = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
await import('@/sync/ops/actions/defaultActionExecutor');

describe('Environment draft hosted as steps (journey-deploy D3: Where → Configure → Review in the Deploy an app dialog)', () => {
  it('one draft instance walks the steps, keeps what was typed across them, and the host only frames it', async () => {
    const serverId = await homes.addHome({
      name: 'Deploy',
      serverUrl: 'https://draft-steps.test',
      accountId: 'alice',
      serverIdentityId: `srv_${'d'.repeat(32)}`,
      currentAccount: true,
    });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const authored: Record<string, unknown>[] = [];
    const committed: unknown[] = [];
    const saved: unknown[] = [];
    const frames: DeploymentDraftFrame[] = [];
    const onExit = vi.fn();
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', {
        body: {
          ok: true,
          sources: [],
          coverage: { complete: true, nextCursor: null },
        },
      });
      await answerExternalActionAccountForHome(homes, serverId, {
        machineId: 'runtime',
        installationId: 'runtime-installation',
        actionId: 'deployments.environments.create',
        tokenEpoch: 0,
        execute: (input) => {
          if (typeof input === 'object' && input !== null && 'mode' in input) {
            const intent =
              DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
            authored.push(intent);
            const {
              mode: _mode,
              name: _name,
              definition: _definition,
              firstTargetLink: _link,
              ...selectors
            } = intent;
            return DeploymentEnvironmentCreatePreviewV1Schema.parse({
              kind: 'preview',
              input: {
                ...selectors,
                controllerMachineId: 'runtime',
                contentArtifactId: 'reviewed-content',
                contentHeaderVersion: 1,
                contentBodyVersion: 1,
              },
              review: {
                creationDefaults: {
                  values: {
                    controllerMachineId: 'runtime',
                    retainPreviousDeployments: 1,
                  },
                  sources: {
                    controllerMachineId: 'explicit',
                    retainPreviousDeployments: 'builtin',
                  },
                },
              },
            });
          }
          committed.push(DeploymentEnvironmentCreateInputV1Schema.parse(input));
          return {
            ok: true,
            environmentId: 'created-environment',
            projectSourceId: 'created-project',
            revision: 1,
          };
        },
      });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [
        createMachineFixture({
          id: 'runtime',
          installationId: 'runtime-installation',
          activeAt: Date.now(),
        }),
      ]);
      const steps = {
        onFrame: (frame: DeploymentDraftFrame) => {
          frames.push(frame);
        },
        onExit,
      };
      function SteppedDraft() {
        const projectChoice = useDeploymentProjectChoice({
          lifetime: account.accountLifetime,
          initiallyNew: true,
        });
        return (
          <DeploymentEnvironmentDraft
            lifetime={account.accountLifetime}
            sourceId={null}
            projectChoice={projectChoice}
            definitionKind="compose"
            phone={false}
            actions={createDeploymentActions(account.accountLifetime)}
            steps={steps}
            onApprovalRequested={() => {}}
            onSaved={(id, next) => saved.push([id, next])}
            onDiscard={() => {}}
          />
        );
      }
      const screen = await renderScreen(<SteppedDraft />);
      const frame = () => frames[frames.length - 1]!;
      const field = (id: string) =>
        screen
          .findAllByType(FieldTextInput)
          .find((node) => node.props.testID === id);
      const settle = (check: () => void) =>
        waitForHomeGovernance(async () => {
          await act(async () => {});
          check();
        });

      // The host frames the steps: no page header of the draft's own, and nothing of Configure on Where.
      expect(screen.findAllByType(PageHeader)).toHaveLength(0);
      await settle(() => expect(frame().step).toBe('where'));
      expect(
        field('project-deployments.draft.composeDocument'),
      ).toBeUndefined();
      // The Machine that answers is chosen for the person; Where can continue without a name typed.
      await settle(() => expect(frame().primary.disabled).toBe(false));
      expect(frame().runsOn).toMatchObject({ kind: 'machine' });

      await act(async () => frame().press());
      await settle(() => expect(frame().step).toBe('configure'));
      await act(async () =>
        field('project-deployments.draft.project.newName')!.props.onChangeText(
          'Operations',
        ),
      );
      await act(async () =>
        field('project-deployments.draft.composeDocument')!.props.onChangeText(
          'services:\n  web:\n    image: nginx:stable\n',
        ),
      );

      // Back to Where and forward again: the same instance, so the document is still there.
      await act(async () => frame().back());
      await settle(() => expect(frame().step).toBe('where'));
      await act(async () => frame().press());
      await settle(() =>
        expect(
          field('project-deployments.draft.composeDocument')?.props.value,
        ).toBe('services:\n  web:\n    image: nginx:stable\n'),
      );

      // Review prepares through the draft's own Action; nothing is committed yet.
      await settle(() => expect(frame().primary.disabled).toBe(false));
      await act(async () => frame().press());
      await settle(() => expect(frame().step).toBe('review'));
      expect(
        screen.findByTestId('project-deployments.draft.defaults'),
      ).not.toBeNull();
      // Review says what Happier creates and what happens next, from the operands it prepared (journey-deploy revM):
      // a new Project and its Environment are saved, then the person deploys from the Environment.
      expect(screen.findByTestId('project-deployments.draft.creates.project')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.draft.creates.environment')).not.toBeNull();
      expect(nextSteps(screen)).toEqual(['create', 'deploy']);
      expect(authored).toHaveLength(1);
      expect(authored[0]).toMatchObject({
        newProject: { name: 'Operations' },
        definition: { from: 'compose' },
      });
      expect(committed).toEqual([]);

      await act(async () => frame().press());
      await settle(() => expect(saved).toHaveLength(1));
      expect(committed).toHaveLength(1);
      expect(saved).toEqual([
        ['created-environment', { projectSourceId: 'created-project' }],
      ]);

      // Back from Where leaves the draft for the host's previous step.
      expect(onExit).not.toHaveBeenCalled();
      await screen.unmount();
    } finally {
      standardCleanup();
      account.dispose();
      storage.setState(previous);
    }
  });

  it.each([
    { label: 'no domains', domains: [] },
    { label: 'required domain', domains: [{ key: 'web', service: 'app', containerPort: 20128, protocol: 'http', required: true }] },
  ] as const)('a catalog app carries its exact pin and required addresses through Configure to Review ($label)', async ({ domains }) => {
    const serverId = await homes.addHome({ name: 'Deploy catalog', serverUrl: 'https://draft-steps-catalog.test', accountId: 'alice',
      serverIdentityId: `srv_${'f'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const authored: Record<string, unknown>[] = [];
    const frames: DeploymentDraftFrame[] = [];
    const templateRef = { sourceId: 'apps', itemId: 'plausible', version: '2.1.0', ref: { kind: 'content' as const, digest: `sha256:${'a'.repeat(64)}` } };
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0, execute: input => {
          const intent = DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
          authored.push(intent);
          const { mode: _mode, name: _name, definition: _definition, firstTargetLink: _link, domainBindings: _domainBindings, ...selectors } = intent;
          return DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: { ...selectors,
            controllerMachineId: 'runtime', contentArtifactId: 'reviewed-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
            review: { creationDefaults: { values: { controllerMachineId: 'runtime', retainPreviousDeployments: 1 },
              sources: { controllerMachineId: 'explicit', retainPreviousDeployments: 'builtin' } } } });
        } });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const steps = { onFrame: (frame: DeploymentDraftFrame) => { frames.push(frame); }, onExit: () => {} };
      function CatalogDraft() {
        const projectChoice = useDeploymentProjectChoice({ lifetime: account.accountLifetime, initiallyNew: true, initialNewProjectName: 'Plausible' });
        return <DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null} projectChoice={projectChoice}
          catalogApp={{ templateRef, title: 'Plausible', domains }} phone={false} actions={createDeploymentActions(account.accountLifetime)}
          steps={steps} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />;
      }
      const screen = await renderScreen(<CatalogDraft />);
      const frame = () => frames[frames.length - 1]!;
      const settle = (check: () => void) => waitForHomeGovernance(async () => { await act(async () => {}); check(); });
      await settle(() => expect(frame().primary.disabled).toBe(false));
      await act(async () => frame().press());
      await settle(() => expect(frame().step).toBe('configure'));
      // The summary names the app; What runs holds only its addresses, and is absent without any (DESIGN-ACCEPT C6).
      expect(screen.findByTestId('project-deployments.draft.catalogApp')).toBeNull();
      const { t } = await import('@/text');
      expect(screen.getTextContent().includes(t('projects.deployments.whatRunsTitle'))).toBe(domains.length > 0);
      if (domains.length) {
        expect(screen.findByTestId('project-deployments.draft.domain.web')).not.toBeNull();
        expect(frame().primary.disabled).toBe(true);
        await act(async () => frame().press());
        expect(authored).toHaveLength(0);
        await act(async () => screen.changeTextByTestId('project-deployments.draft.domain.web', 'app.example.test'));
      } else {
        expect(screen.findByTestId('project-deployments.draft.domain.web')).toBeNull();
      }
      await settle(() => expect(frame().primary.disabled).toBe(false));
      await act(async () => frame().press());
      await settle(() => expect(frame().step).toBe('review'));
      expect(authored).toHaveLength(1);
      expect(authored[0]).toMatchObject({ newProject: { name: 'Plausible' }, definition: { from: 'catalogApp', templateRef },
        firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] } });
      expect(authored[0]?.domainBindings).toEqual(domains.length ? [{ templateDomainId: 'web', hostname: 'app.example.test' }] : undefined);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('a refused Create keeps what was asked under the lifecycle owner’s notice and drops what would have happened next (journey-deploy revFail)', async () => {
    const serverId = await homes.addHome({ name: 'Deploy refused', serverUrl: 'https://draft-steps-refused.test', accountId: 'alice',
      serverIdentityId: `srv_${'9'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const frames: DeploymentDraftFrame[] = [];
    const templateRef = { sourceId: 'apps', itemId: 'plausible', version: '2.1.0', ref: { kind: 'content' as const, digest: `sha256:${'b'.repeat(64)}` } };
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime', installationId: 'runtime-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0, execute: input => {
          if (typeof input !== 'object' || input === null || !('mode' in input)) return { refused: true };
          const { mode: _mode, name: _name, definition: _definition, firstTargetLink: _link, ...selectors } =
            DeploymentEnvironmentCreateIntentInputV1Schema.parse(input);
          return DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: { ...selectors,
            controllerMachineId: 'runtime', contentArtifactId: 'reviewed-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
            review: { creationDefaults: { values: { controllerMachineId: 'runtime', retainPreviousDeployments: 1 },
              sources: { controllerMachineId: 'explicit', retainPreviousDeployments: 'builtin' } } } });
        },
        failure: result => typeof result === 'object' && result !== null && 'refused' in result
          ? { errorCode: 'invalid_parameters', error: 'invalid_parameters' } : null });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const steps = { onFrame: (frame: DeploymentDraftFrame) => { frames.push(frame); }, onExit: () => {} };
      function CatalogDraft() {
        const projectChoice = useDeploymentProjectChoice({ lifetime: account.accountLifetime, initiallyNew: true, initialNewProjectName: 'Plausible' });
        return <DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null} projectChoice={projectChoice}
          catalogApp={{ templateRef, title: 'Plausible', domains: [] }} phone={false} actions={createDeploymentActions(account.accountLifetime)}
          steps={steps} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />;
      }
      const screen = await renderScreen(<CatalogDraft />);
      const frame = () => frames[frames.length - 1]!;
      const settle = (check: () => void) => waitForHomeGovernance(async () => { await act(async () => {}); check(); });
      await settle(() => expect(frame().primary.disabled).toBe(false));
      await act(async () => frame().press());
      await settle(() => expect(frame().primary.disabled).toBe(false));
      await act(async () => frame().press());
      await settle(() => expect(frame().step).toBe('review'));
      expect(nextSteps(screen)).toEqual(['create', 'deploy']);

      await act(async () => frame().press());
      await settle(() => expect(screen.findByTestId('project-deployments.draft.refused')).not.toBeNull());
      expect(frame().step).toBe('review');
      expect(screen.findByTestId('project-deployments.draft.creates.environment')).not.toBeNull();
      expect(nextSteps(screen)).toBeUndefined();
      // revFail: nothing was created, and the row Create refused says so where it stands.
      const { t } = await import('@/text');
      const rowText = (testID: string) => screen.findByTestId(testID)?.findAll(() => true)
        .flatMap(node => node.children.filter(value => typeof value === 'string')).join(' ') ?? '';
      expect(rowText('project-deployments.draft.creates.project')).toContain(t('newApp.deploy.plan.notCreated'));
      expect(screen.findByTestId('project-deployments.draft.creates.environment.refused')).not.toBeNull();
      expect(frame().refused, 'the dialog says nothing was created').toBe(true);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('Where shows the targets as tiles: the Machine tile holds its picker and says when that Machine is away (journey-deploy whereM, whereErr)', async () => {
    const serverId = await homes.addHome({ name: 'Deploy where', serverUrl: 'https://draft-steps-where.test', accountId: 'alice',
      serverIdentityId: `srv_${'9'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const frames: DeploymentDraftFrame[] = [];
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [
        createMachineFixture({ id: 'away', installationId: 'away-installation', activeAt: Date.now() - 7 * 24 * 3600_000 }),
        createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() }),
      ]);
      const steps = { onFrame: (frame: DeploymentDraftFrame) => { frames.push(frame); }, onExit: () => {} };
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null}
        definitionKind="compose" phone={false} actions={createDeploymentActions(account.accountLifetime)} steps={steps}
        initialMachineId="away" onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
      const tiles = () => screen.findAllByType(SelectionTiles).find(node => node.props.testIdPrefix === 'project-deployments.draft.target');
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(frames.length).toBeGreaterThan(0); });
      // A Compose file runs on a Machine only, yet Where still reads as targets: the Machine, then More platforms last.
      expect(tiles()?.props.options.map((option: { id: string }) => option.id)).toEqual(['own-server', 'plugins']);
      // The chosen target leads across its row; each card's body sits under its title row (jdF-whereM).
      expect(tiles()?.props.options.map((option: { span?: string }) => option.span ?? null)).toEqual(['row', null]);
      expect(tiles()?.props.descriptionPlacement).toBe('below');
      // The away Machine says so inside its tile, and Where cannot continue on it.
      expect(screen.findByTestId('project-deployments.draft.machineAway')).not.toBeNull();
      expect(frames[frames.length - 1]!.primary.disabled).toBe(true);
      const machineField = screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine')!;
      await act(async () => machineField.props.onSelectMachine({ id: 'runtime' }));
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(frames[frames.length - 1]!.primary.disabled).toBe(false); });
      expect(screen.findByTestId('project-deployments.draft.machineAway')).toBeNull();
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('one notice per cause: a target refusal for a Machine that is not answering is said once, by that Machine (journey-deploy revFail)', async () => {
    const serverId = await homes.addHome({ name: 'Deploy notice', serverUrl: 'https://draft-steps-notice.test', accountId: 'alice',
      serverIdentityId: `srv_${'8'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository: {
          provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'alice/app', cloneUrl: 'https://github.com/alice/app.git' }, protocol: 'https' },
        defaultRef: 'main' } } });
      homes.answer(serverId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] } });
      await answerExternalActionAccountForHome(homes, serverId, { machineId: 'here', installationId: 'here-installation',
        actionId: 'deployments.environments.create', tokenEpoch: 0,
        execute: () => null,
        failure: () => ({ errorCode: 'target_unavailable', error: 'target_unavailable' }) });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [
        createMachineFixture({ id: 'away', installationId: 'away-installation', active: false }),
        createMachineFixture({ id: 'here', installationId: 'here-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
        phone={false} actions={createDeploymentActions(account.accountLifetime, 'source-app')}
        onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const machine = () => screen.findAllByType(SessionMachineField).find(node => node.props.testID === 'project-deployments.draft.machine')!;
      // The person picks the away Machine on purpose; the draft still lets them try.
      await act(async () => machine().props.onSelectMachine({ id: 'away' }));
      const header = () => screen.findAllByType(PageHeader)[0]!;
      await act(async () => header().props.titleEditor.onChangeText('Shop'));
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(header().props.primaryAction.disabled).toBe(false); });
      await act(async () => header().props.primaryAction.onPress());
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId('project-deployments.draft.machineAwayNotice')).not.toBeNull(); });
      // Exactly one notice says it, as the shared line at the Machine it concerns: no banner, no "Couldn't save" card.
      expect(screen.findAllByType(AttentionBanner).map(node => node.props.testID)).toEqual([]);
      const notice = screen.findAllByType(SurfaceStateCard).filter(node => node.props.testID === 'project-deployments.draft.machineAwayNotice');
      expect(notice.map(node => node.props.size)).toEqual(['line']);
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('a suggested own-server target lands on the Machine card and can continue (AUTO-U1 03:58Z)', async () => {
    const { OWN_SERVER_DEPLOYMENT_TARGET_V1 } = await import('@happier-dev/deployments');
    const serverId = await homes.addHome({ name: 'Deploy suggested', serverUrl: 'https://draft-steps-suggested.test', accountId: 'alice',
      serverIdentityId: `srv_${'7'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const frames: DeploymentDraftFrame[] = [];
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const steps = { onFrame: (frame: DeploymentDraftFrame) => { frames.push(frame); }, onExit: () => {} };
      const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId={null}
        definitionKind="compose" phone={false} actions={createDeploymentActions(account.accountLifetime)} steps={steps}
        initialTargetKey={OWN_SERVER_DEPLOYMENT_TARGET_V1.id} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
      const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
      const tiles = () => screen.findAllByType(SelectionTiles).find(node => node.props.testIdPrefix === 'project-deployments.draft.target');
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(frames[frames.length - 1]?.primary.disabled).toBe(false); });
      expect(tiles()?.props.value).toBe(OWN_SERVER_DEPLOYMENT_TARGET_V1.id);
      expect(frames[frames.length - 1]!.runsOn).toMatchObject({ kind: 'machine' });
      await screen.unmount();
    } finally { standardCleanup(); account.dispose(); storage.setState(previous); }
  });

  it('Back from Where hands the flow back to its host', async () => {
    const serverId = await homes.addHome({
      name: 'Deploy back',
      serverUrl: 'https://draft-steps-back.test',
      accountId: 'alice',
      serverIdentityId: `srv_${'e'.repeat(32)}`,
      currentAccount: true,
    });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const frames: DeploymentDraftFrame[] = [];
    const onExit = vi.fn();
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', {
        body: {
          ok: true,
          sources: [],
          coverage: { complete: true, nextCursor: null },
        },
      });
      await publishMachineInventoryForTest(account.accountLifetime.scope, []);
      const steps = {
        onFrame: (frame: DeploymentDraftFrame) => {
          frames.push(frame);
        },
        onExit,
      };
      const screen = await renderScreen(
        <DeploymentEnvironmentDraft
          lifetime={account.accountLifetime}
          sourceId={null}
          definitionKind="image"
          phone={false}
          actions={createDeploymentActions(account.accountLifetime)}
          steps={steps}
          onApprovalRequested={() => {}}
          onSaved={() => {}}
          onDiscard={() => {}}
        />,
      );
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(frames.length).toBeGreaterThan(0);
      });
      // No Machine answers: Where cannot continue, and says so through its own state.
      expect(frames[frames.length - 1]!.primary.disabled).toBe(true);
      await act(async () => frames[frames.length - 1]!.back());
      expect(onExit).toHaveBeenCalledOnce();
      await screen.unmount();
    } finally {
      standardCleanup();
      account.dispose();
      storage.setState(previous);
    }
  });
});

function nextSteps(screen: Awaited<ReturnType<typeof renderScreen>>): string[] | undefined {
  return screen.findAllByType(SetupSteps).find(node => node.props.testID === 'project-deployments.draft.next')
    ?.props.steps.map((step: { key: string }) => step.key);
}

function field(screen: Awaited<ReturnType<typeof renderScreen>>, id: string) {
  return screen.findAllByType(FieldTextInput).find(node => node.props.testID === id)!;
}
