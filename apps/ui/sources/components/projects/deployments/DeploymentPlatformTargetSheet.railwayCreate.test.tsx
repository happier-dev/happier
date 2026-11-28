import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createPluginHttpFixture,
  createPluginTestkit,
  createTestResourceInvocationContext,
} from '@happier-dev/plugin-sdk/testing';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { PluginProjectedActionV2Schema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { resolveInputTypeOptions } from '@happier-dev/protocol/inputs/inputTypeRuntime';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import * as railway from '../../../../../../packages/plugins/deploy-railway/src/index';
import {
  act,
  pressTestInstanceAsync,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import {
  createMachineFixture,
  createMachineMetadataFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  createAccountTokenForTests,
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
      settleTransientConfirmations: false,
    }).module,
);
vi.mock(
  '@/components/ui/popover/Popover',
  async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
      importOriginal as never,
    ) as never,
);
const receiverRpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () =>
    (
      await import('@/dev/testkit/mocks/serverScopedRpc')
    ).createServerScopedMachineRpcBoundaryMock(receiverRpc.call),
);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { installPortableAccountPluginReleaseForTest } =
  await import('@/dev/testkit/harness/portableAccountPlugin');
const { createDeploymentActions } = await import('./deploymentActions');
const { showDeploymentPlatformTargetSheet } =
  await import('./DeploymentPlatformTargetSheet');
const { readDeploymentPlatformTargets } = await import('./platformTargetLink');
const { ModalProvider, Modal } = await import('@/modal');
const { ConnectedAccountPurposeTargetChooser } =
  await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
const { ActionInputFields } =
  await import('@/components/sessions/actions/ActionInputFields');
const { SurfaceStateCard } =
  await import('@/components/ui/surfaces/SurfaceStateCard');
const { SegmentedChoiceItem } =
  await import('@/components/ui/lists/SegmentedChoiceItem');

afterEach(async () => {
  await act(async () => Modal.hideAll());
  standardCleanup();
});

const json = (value: unknown) => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(value)),
});
const page = { hasNextPage: false, endCursor: null };

/**
 * The person starts from New, creates a Railway project from the project picker, and finishes on New: the created
 * project and its environment are selected and Create and link stays the next step. A just-created project has no
 * services, so Existing on that project says what follows instead of a silent empty Service field.
 */
it.each(['new', 'existing'] as const)(
  'finishes the %s path after creating a Railway project from the picker',
  async (path) => {
    const accountId = 'railway-create-owner';
    const projectSourceId = 'orders-source';
    const account = {
      service: {
        pluginId: 'happier.machine.railway',
        localId: 'railway-account',
      },
      accountId: 'railway-token',
    };
    const credentials = {
      token: createAccountTokenForTests(accountId, { currentAccount: true }),
      secret: encodeBase64(new Uint8Array(32).fill(23), 'base64url'),
    };
    const serverId = await homes.addHome({
      name: 'Railway create',
      serverUrl: `https://railway-create-${path}.test`,
      serverIdentityId: `srv_${'c'.repeat(32)}`,
      accountId,
      currentAccount: true,
      accountEncryptionMode: 'e2ee',
      credentials,
    });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
      body: createAccountEncryptionCurrentnessFixtureForCredentials(
        credentials,
      ),
    });
    const context = await captureLazyActionAccountContext(serverId);
    const { manifest } = railway;
    const installed = await installPortableAccountPluginReleaseForTest({
      manifest,
      activate: railway.activateAccount,
      accountLifetime: context.accountLifetime,
      publishProjection: true,
    });
    const qualified = (localId: string) =>
      buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId });
    const definitions = manifest.contributes.inputTypes ?? [];
    receiverRpc.call.mockResolvedValue({
      protocolVersion: 1,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        actionsById: Object.fromEntries(
          Object.entries(installed.projection.actionsById).map(([id, action]) => [
            id,
            Object.fromEntries(
              Object.entries(action).filter(([field]) =>
                Object.hasOwn(PluginProjectedActionV2Schema.shape, field),
              ),
            ),
          ]),
        ),
        familiesById: {
          inputTypes: {
            family: 'inputTypes',
            entriesById: Object.fromEntries(
              definitions.map((definition) => [
                qualified(definition.id),
                {
                  id: qualified(definition.id),
                  pluginId: manifest.id,
                  pluginVersion: manifest.version,
                  definition,
                },
              ]),
            ),
          },
        },
        resourcesById: Object.fromEntries(
          (manifest.contributes.resources ?? [])
            .filter((resource) => resource.source === 'dynamic')
            .map((resource) => [
              qualified(resource.id),
              {
                pluginId: manifest.id,
                id: resource.id,
                resourceKind: resource.kind,
                scope: resource.scope,
                execution: resource.execution,
                accountRuntimeDeclared: true,
              },
            ]),
        ),
      }),
    });
    // One Railway workspace with one older project; the created project starts with its production environment and no services.
    const projects = [{ id: 'warehouse-project', name: 'Warehouse orders' }];
    const creates: unknown[] = [];
    const kit = await createPluginTestkit({
      manifest,
      module: railway,
      services: {
        connectedAccounts: {
          async getBinding(purpose) {
            return {
              purpose,
              account,
              service: account.service,
              target: { kind: 'account', displayName: 'Cedar Invoicing' },
            };
          },
          async materialize() {
            return { kind: 'environment', env: {} };
          },
        },
        http: createPluginHttpFixture({
          async request(raw) {
            const { query, variables } = JSON.parse(
              new TextDecoder().decode(raw.body),
            );
            if (query.includes('projectCreate')) {
              creates.push(variables.input);
              projects.push({
                id: 'orders-project',
                name: variables.input.name,
              });
              return json({
                data: {
                  projectCreate: {
                    id: 'orders-project',
                    name: variables.input.name,
                    workspaceId: variables.input.workspaceId,
                    environments: {
                      edges: [
                        {
                          node: { id: 'orders-production', name: 'production' },
                        },
                      ],
                    },
                  },
                },
              });
            }
            if (query.includes('serviceInstances'))
              return json({
                data: {
                  environment: {
                    id: variables.environmentId,
                    projectId: variables.projectId,
                    serviceInstances: { edges: [], pageInfo: page },
                  },
                },
              });
            if (query.includes('environments('))
              return json({
                data: {
                  project: {
                    environments: {
                      edges: [
                        {
                          node: {
                            id:
                              variables.projectId === 'orders-project'
                                ? 'orders-production'
                                : 'warehouse-production',
                            name: 'production',
                          },
                        },
                      ],
                      pageInfo: page,
                    },
                  },
                },
              });
            if (query.includes('projects('))
              return json({
                data: {
                  projects: {
                    edges: projects.map((node) => ({ node })),
                    pageInfo: page,
                  },
                },
              });
            if (query.includes('workspaces'))
              return json({
                data: {
                  me: { workspaces: [{ id: 'workshop', name: 'Workshop' }] },
                  externalWorkspaces: [],
                },
              });
            throw new Error(`Unexpected Railway query: ${query}`);
          },
        }),
      },
    });
    try {
      const target = readDeploymentPlatformTargets([{ manifest }])[0]!;
      const declaredFields = (actionId: string) =>
        actionId === target.create?.actionId
          ? (target.create?.fields ?? [])
          : actionId === target.inspectActionId
            ? target.fields
            : ((manifest.contributes.actions ?? []).find(
                (action) => action.id === 'project-create',
              )?.inputHints?.fields ?? []);
      const machineId = 'railway-create-controller';
      const installationId = 'railway-create-installation';
      const optionsActionId = getActionSpec('action.options.resolve').id;
      const boundary = await answerExternalActionAccountForHome(
        homes,
        serverId,
        {
          actionId: optionsActionId,
          machineId,
          installationId,
          tokenEpoch: 0,
          requesterInvocation: 'required',
          failure: (result) => readActionFailureEnvelope(result),
          execute: async (raw) => {
            const input = getActionSpec(optionsActionId).inputSchema.parse(raw);
            const identity = declaredFields(input.actionId).find(
              (field) => field.path === input.fieldPath,
            )?.inputType;
            if (!identity || 'hostType' in identity || !input.fieldPath)
              throw new Error(
                `Expected a declared Railway field: ${input.fieldPath}`,
              );
            const result = await resolveInputTypeOptions({
              identity,
              ctx: {},
              query: {
                fieldPath: input.fieldPath,
                draftInput: input.draftInput,
              },
              readFailure: readActionFailureEnvelope,
              deps: {
                async resolveInputType(ref) {
                  const definition = definitions.find(
                    (entry) => entry.id === ref.localId,
                  );
                  return definition
                    ? {
                        identity: ref,
                        occurrenceId: installationId,
                        definition,
                      }
                    : null;
                },
                async readInputTypeResource({ resource, query }) {
                  const runtime = kit.registration(
                    'resources',
                    resource.localId,
                  );
                  if (!runtime)
                    throw new Error('Expected the Railway options Resource');
                  try {
                    const value = await runtime.read(
                      createTestResourceInvocationContext({
                        query,
                        async readAction(ref, payload) {
                          try {
                            return {
                              ok: true,
                              result: await kit.invokeAction(
                                ref.localId,
                                payload,
                                { surface: 'plugin' },
                              ),
                            };
                          } catch (error) {
                            if (!isPluginError(error)) throw error;
                            return {
                              ok: false,
                              errorCode: error.code,
                              error: error.message,
                            };
                          }
                        },
                      }),
                    );
                    return JSON.parse(
                      typeof value === 'string'
                        ? value
                        : new TextDecoder().decode(value),
                    );
                  } catch (error) {
                    if (!isPluginError(error)) throw error;
                    return {
                      ok: false,
                      errorCode: error.code,
                      error: error.message,
                    };
                  }
                },
              },
            });
            return result.ok
              ? {
                  actionId: input.actionId,
                  fieldPath: input.fieldPath,
                  optionsSourceId: null,
                  options: result.result,
                }
              : result;
          },
        },
      );
      await answerExternalActionAccountForHome(homes, serverId, {
        actionId: ACTION_INVOKE_ACTION_ID_V1,
        machineId,
        installationId,
        tokenEpoch: 0,
        requesterInvocation: 'required',
        execute: (raw) => {
          const input = getActionSpec(
            ACTION_INVOKE_ACTION_ID_V1,
          ).inputSchema.parse(raw);
          return kit.invokeAction(input.action.localId, input.input);
        },
      });
      const { encryption } = await context.resolveAccountEncryption();
      const installationPublicKey = boundary.machine.installationPublicKey;
      if (!encryption || !installationPublicKey)
        throw new Error('Expected the encrypted Account and Machine');
      const encryptor = await encryption.openEncryption(null);
      const metadata = createMachineMetadataFixture({ installationPublicKey });
      boundary.machine.metadata = encodeBase64(
        (await encryptor.encrypt([metadata]))[0]!,
        'base64',
      );
      await publishMachineInventoryForTest(context.accountLifetime.scope, [
        createMachineFixture({
          id: machineId,
          installationId,
          installationPublicKey,
          metadata,
          activeAt: Date.now(),
          storageMode: 'e2ee',
          dataEncryptionKey: boundary.machine.dataEncryptionKey,
          access: boundary.machine.access,
        }),
      ]);
      homes.answer(serverId, `GET /v1/projects/sources/${projectSourceId}`, {
        body: {
          ok: true,
          canManage: true,
          source: {
            id: projectSourceId,
            revision: 1,
            name: 'Orders API',
            owner: { kind: 'account', accountId },
            audience: [],
            createdByAccountId: accountId,
            defaultRef: 'main',
            repository: {
              provider: {
                id: 'github',
                kind: 'github',
                displayName: 'GitHub',
                baseUrl: 'https://github.com',
              },
              repository: {
                nameWithOwner: 'cedar/orders-api',
                defaultBranch: 'main',
              },
              protocol: 'https',
            },
          },
        },
      });
      homes.answer(serverId, 'POST /v1/deployments/targets/list', {
        body: { ok: true, items: [], nextCursor: null, coverage: 'complete' },
      });

      const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
      let existingLead: unknown;
      try {
        await act(async () =>
          showDeploymentPlatformTargetSheet({
            name: 'Orders API',
            environment: {
              id: 'environment',
              revision: 4,
              definition: { kind: 'repository' },
              projectSourceId,
            },
            ownerAccountId: accountId,
            lifetime: context.accountLifetime,
            actions: createDeploymentActions(context.accountLifetime, ''),
            onApproval: () => {},
            initialTargetKey: target.key,
          }),
        );
        await waitForHomeGovernance(() =>
          expect(
            screen.root.findAllByType(ConnectedAccountPurposeTargetChooser),
          ).toHaveLength(1),
        );
        await act(async () =>
          screen.root
            .findByType(ConnectedAccountPurposeTargetChooser)
            .props.onChange({ kind: 'account', account }, null),
        );
        const mode = () =>
          screen.root
            .findAllByType(SegmentedChoiceItem)
            .find(
              (node) =>
                node.props.testID === 'project-deployments.platform.mode',
            )!;
        if (path === 'new')
          await act(async () => mode().props.onChange('create'));
        const projectRow = () =>
          screen.root
            .findAllByType(ActionInputFields)
            .find(
              (node) => node.props.fields[0]?.path === 'providerAccountId',
            )!;
        const trigger = () =>
          screen.root
            .findAllByType('Pressable' as never)
            .find((node) =>
              String(node.props.accessibilityLabel ?? '').startsWith(
                'Railway project:',
              ),
            );
        await waitForHomeGovernance(() =>
          expect(trigger(), screen.getTextContent()).toBeDefined(),
        );
        await waitForHomeGovernance(() =>
          expect(
            projectRow().props.resolveFieldOptions.state(
              projectRow().props.fields[0],
            ).status,
          ).toBe('ready'),
        );
        await pressTestInstanceAsync(trigger());
        const createChoice = screen.root
          .findAllByType('Pressable' as never)
          .find((node) =>
            String(node.props.accessibilityLabel ?? '').startsWith(
              'Create Railway project',
            ),
          );
        expect(createChoice, screen.getTextContent()).toBeDefined();
        await pressTestInstanceAsync(createChoice);
        const form = () =>
          screen.root
            .findAllByType(ActionInputFields)
            .find((node) =>
              node.props.fields.some(
                (field: { path: string }) => field.path === 'name',
              ),
            )!;
        await waitForHomeGovernance(() => expect(form()).toBeDefined());
        await act(async () =>
          form().props.onPatch({ workspaceId: 'workshop' }),
        );
        await act(async () => form().props.onPatch({ name: 'Orders API' }));
        await screen.pressByTestIdAsync(
          'plugin-contributed-action-form-submit',
        );
        await waitForHomeGovernance(() =>
          expect(
            screen.findByTestId('app-shell-confirmation-confirm'),
            screen.getTextContent(),
          ).not.toBeNull(),
        );
        await pressTestInstanceAsync(
          screen.findByTestId('app-shell-confirmation-confirm'),
        );
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(creates, screen.getTextContent()).toEqual([
            { name: 'Orders API', workspaceId: 'workshop' },
          ]);
          expect(
            projectRow().props.input.providerAccountId,
            screen.getTextContent(),
          ).toBe('orders-project');
        });

        if (path === 'existing') {
          // Existing on a project with no services settles empty, with no error card and no Retry, and its next step
          // beside the empty line leads to New.
          const service = () => screen.root.findAllByType(ActionInputFields)
            .find((node) => node.props.fields[0]?.path === 'providerEnvironment');
          await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(service()?.props.resolveFieldOptions.state(service()!.props.fields[0]), screen.getTextContent())
              .toMatchObject({ status: 'ready', options: [] });
            expect(screen.findByTestId('project-deployments.platform.createNew'), screen.getTextContent()).not.toBeNull();
          });
          expect(mode().props.value).toBe('existing');
          expect(screen.root.findAllByType(SurfaceStateCard)
            .filter((card) => card.props.testID === 'project-deployments.platform.choicesFailed')).toEqual([]);
          expect(screen.findByTestId('project-deployments.platform.check')?.props.disabled).toBe(true);
          // An empty choice with a next step draws no dead field box: it says it is empty and offers the step.
          expect(screen.root.findAllByType('Pressable' as never)
            .filter((node) => String(node.props.accessibilityLabel ?? '').startsWith('Railway service'))).toEqual([]);
          existingLead = screen.findByTestId('project-deployments.platform.lead')?.props.children;
          expect(existingLead).toEqual(expect.any(String));
          await screen.pressByTestIdAsync('project-deployments.platform.createNew');
        }
        // New carries the created project and its environment: Create and link is the next step, nothing re-chosen.
        await waitForHomeGovernance(async () => {
          await act(async () => {});
          expect(mode().props.value).toBe('create');
          expect(projectRow().props.input, screen.getTextContent()).toMatchObject({
            providerAccountId: 'orders-project',
            providerEnvironment: { kind: 'native', selection: { projectId: 'orders-project', environmentId: 'orders-production' } },
            resourceName: 'orders-api',
            productionBranch: 'main',
          });
          expect(screen.findByTestId('project-deployments.platform.create')?.props.disabled, screen.getTextContent()).toBe(false);
        });
        expect(screen.findByTestId('project-deployments.platform.check')).toBeNull();
        // The sheet's lead says what this mode does: New creates at the provider, so it no longer claims nothing changes there.
        const newLead = screen.findByTestId('project-deployments.platform.lead')?.props.children;
        expect(newLead).toEqual(expect.any(String));
        if (existingLead !== undefined) expect(newLead).not.toBe(existingLead);
        expect(creates).toHaveLength(1);
      } finally {
        await screen.unmount();
      }
    } finally {
      await kit.dispose();
      await installed.dispose();
      context.dispose();
      await homes.reset();
    }
  },
);
