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
