import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  changeTextTestInstance,
  createMachineFixture,
  flushHookEffects,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks, promptRegistriesRouterPushSpy } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  DeploymentTemplateInstantiateInputV1Schema,
  DeploymentTemplateInstantiateResultV1Schema,
  DeploymentTemplateInstantiationPartialV1Schema,
  DeploymentPublishPrepareInputV1Schema,
  DeploymentPublishPrepareResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/registries';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createApprovalArtifact } from '@/sync/ops/actions/approvalArtifactWriter';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

const viewport = vi.hoisted(() => ({ width: 1440, height: 900 }));

// The real Registry read, App preparation hook, Action front door and Store listing body run; only the Home's
// HTTP boundary answers (the same harness as the App data owner's own test).
installPromptRegistriesCommonModuleMocks({
  storage: (original) => original(),
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View', ScrollView: 'ScrollView', TextInput: 'TextInput',
      Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
      // Window geometry is a platform boundary; pane routing and retention stay real.
      useWindowDimensions: () => ({ width: viewport.width, height: viewport.height }),
    });
  },
  text: () => vi.importActual('@/text'),
});
const { t } = await import('@/text');
vi.mock('@react-navigation/native', async () =>
  (
    await import('@/dev/testkit/mocks/reactNavigation')
  ).createReactNavigationNativeMock(),
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storage');
const { resolveActionsSettingsV1FromState } = await import('@/sync/domains/settings/actionsSettings');
const { createUiDeploymentActionDeps } = await import('@/sync/api/deployments/deploymentActions');
const { StoreListingBody } = await import('./StoreListing');
const { StoreKindSurface } = await import('./StoreKindSurface');
const { useStoreAppListing } = await import('./useStoreAppListing');
beforeEach(async () => { await homes.reset(); viewport.width = 1440; viewport.height = 900; });
afterEach(standardCleanup);

let sequence = 0;
async function createFixture(extraDomains: ReadonlyArray<{ key: string; required: boolean }> = [],
  options: Readonly<{ teams?: boolean; domains?: ReturnType<typeof DeploymentTemplateV1Schema.parse>['domains']; receivingTemplate?: boolean; templateInputs?: boolean; machineCatalogs?: boolean; catalogLicense?: string; ports?: boolean }> = {}) {
  const serverUrl = `https://store-app-presenter-${++sequence}.test`;
  const catalogUrl = `${serverUrl}/apps.json`;
  const sourceId = deriveMarketplaceSourceId(catalogUrl);
  const catalog = createPromptLibraryCatalogBoundary({
    records: [
      {
        key: 'registry-sources',
        value: {
          v: 2,
          sources: [
            {
              id: sourceId,
              title: 'Happier picks',
              url: catalogUrl,
              format: 'happier-catalog',
              kinds: ['app'],
              enabled: true,
              addedAt: 1,
            },
          ],
          disabledSourceIds: [],
        },
      },
    ],
  });
  const app = DeploymentTemplateV1Schema.parse({
    schemaVersion: 1,
    title: 'Uptime Kuma',
    description: 'Watch your sites and publish a status page',
    compose: {
      document: `services:\n  kuma:\n    image: louislam/uptime-kuma:2\n${options.ports ? '    container_name: kuma-1\n    ports:\n      - "3001:3001"\n' : ''}${options.templateInputs ? '  sidecar:\n    image: busybox:1\n' : ''}`,
      profiles: [],
      services: ['kuma'],
    },
    variables: options.templateInputs ? [
      { key: 'APP_USER', label: 'App user', required: true, valueKind: 'string', secret: false, sites: [] },
      { key: 'INTERNAL_APP_REGION', label: 'INTERNAL_APP_REGION', required: false, valueKind: 'string', secret: false, sites: [] },
    ] : [],
    ...(options.templateInputs ? { companions: [{ id: 'sidecar', title: 'Add sidecar', services: ['sidecar'] }] } : {}),
    generatedSecrets: [],
    domains: options.domains ?? [
      {
        key: 'web',
        service: 'kuma',
        containerPort: 3001,
        protocol: 'https',
        required: true,
        healthCheck: { path: '/', expectStatus: 200 },
      },
      ...extraDomains.map(domain => ({ ...domain, service: 'kuma', containerPort: 3001, protocol: 'https', healthCheck: { path: '/', expectStatus: 200 } })),
    ],
    volumes: [
      {
        id: 'data',
        service: 'kuma',
        target: '/app/data',
        persistent: true,
        backup: true,
      },
    ],
    firstRunSetup: true,
  });
  const preparations: ReturnType<
    typeof DeploymentPublishPrepareInputV1Schema.parse
  >[] = [];
  const { createRegistryHostV1, RegistryItemV1Schema, registryContentRefEqualV1 } = await import('@happier-dev/protocol/registries');
  const machineItems = new Map<string, ReturnType<typeof RegistryItemV1Schema.parse>>();
  if (options.machineCatalogs) {
    for (const machineId of ['target', 'second-target']) {
      const host = createRegistryHostV1({ host: 'node', readSources: async () => [{ id: sourceId, title: 'Apps',
        url: catalogUrl, format: 'happier-catalog', kinds: ['app'], enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true }],
        http: { getJson: async () => ({ ok: true, fetchedAt: 1, value: { schemaVersion: 1, apps: [{ itemId: 'uptime-kuma',
          app: { ...app, title: machineId, compose: { ...app.compose, document: `${app.compose.document}# ${machineId}\n` } } }] } }),
          getText: async () => { throw new Error('Unexpected text read'); },
          getBytes: async () => { throw new Error('Unexpected byte read'); } } });
      const result = await host.fetchRequest({ op: 'read', kind: 'app', sourceId, itemId: 'uptime-kuma' });
      if (result.op !== 'read') throw new Error('Expected Machine catalog item');
      machineItems.set(machineId, options.catalogLicense === undefined ? result.item : RegistryItemV1Schema.parse({
        ...result.item,
        summary: { ...result.item.summary, license: options.catalogLicense },
      }));
    }
    const rpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const original = rpc.machineRpcWithServerScope;
    vi.spyOn(rpc, 'machineRpcWithServerScope').mockImplementation(createServerScopedMachineRpcBoundaryMock(async request => {
      if (request.method !== 'daemon.registries.fetch') return original(request);
      const { RegistryFetchRequestV1Schema } = await import('@happier-dev/protocol/registries');
      const input = RegistryFetchRequestV1Schema.parse(request.payload);
      if (input.op !== 'read' || input.sourceId !== sourceId) throw new Error('Unexpected registry request');
      return { op: 'read', item: machineItems.get(request.machineId)! };
    }).machineRpcWithServerScope);
  }
  const mode: { value: 'prepared' | 'refused' | 'approval'; failure?: ActionExecuteFailure } = { value: 'prepared' };
  const serverId = await homes.addHome({
    name: 'App Home',
    serverUrl,
    accountId: 'owner',
    currentAccount: true,
    serverIdentityId: `srv_${'d'.repeat(32)}`,
    ...(options.teams ? { teamsEnabled: true } : {}),
  });
  if (options.teams) {
    homes.answer(serverId, '/v1/teams/list', { body: { items: [teamSummaryFixture({ id: 'team-ops', name: 'Ops' })], nextCursor: null } });
  }
  for (const path of [
    '/v1/account/entity-rows/prompt-library',
    '/v1/account/entity-rows/prompt-library/registry-sources',
  ]) {
    homes.answer(serverId, path, {
      body: await (await catalog.handle(path))!.json(),
    });
  }
  homes.answer(serverId, '/apps.json', {
    select: () => {
      if (options.machineCatalogs) throw new TypeError('Network request failed');
      return ({
      body: {
        schemaVersion: 1,
        apps: [
          { itemId: 'uptime-kuma', app },
          { itemId: 'needs-review', app, unsupported: true },
        ],
      },
    }); },
  });
  const failure = (result: unknown) => ActionExecuteFailureSchema.safeParse(result).data ?? null;
  await answerExternalActionAccountForHome(homes, serverId, {
    actionId: 'deployments.publish.prepare', machineId: 'target', installationId: 'installed', tokenEpoch: 0, failure,
    ...(options.machineCatalogs ? { additionalMachines: [{ machineId: 'second-target', installationId: 'second-install' }] } : {}),
    execute: (raw) => {
      const input = DeploymentPublishPrepareInputV1Schema.parse(raw);
      preparations.push(input);
      const current = machineItems.get(input.machineId);
      if (current?.payload.kind === 'app' && current.payload.state === 'ready'
        && !registryContentRefEqualV1(input.templateRef.ref, current.payload.ref)) {
        return { ok: false, errorCode: 'template_changed', error: 'template_changed' };
      }
      const result = DeploymentPublishPrepareResultV1Schema.parse({
        kind: 'prepared',
        templateRef: input.templateRef,
        // The Home echoes the exact existing Source, or the reviewed new Project and its intended owner.
        project: input.newProject
          ? { newProject: input.newProject, owner: input.newProject.owner }
          : {
              projectSourceId: input.projectSourceId,
              sourceRevision: input.sourceRevision,
              owner: { kind: 'account', accountId: 'owner' },
            },
        machine: {
          machineId: input.machineId,
          installationId: input.installationId,
        },
        template: current?.payload.kind === 'app' && current.payload.state === 'ready' ? current.payload.app : app,
        creationDefaults: {
          values: {
            controllerMachineId: 'target',
            retainPreviousDeployments: 2,
          },
          sources: {
            controllerMachineId: 'account',
            retainPreviousDeployments: 'builtin',
          },
        },
      });
      return mode.value === 'refused'
        ? mode.failure ?? { ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable' }
        : mode.value === 'approval'
          ? { kind: 'approval_request_created', artifactId: 'prepare-approval', actionId: 'deployments.publish.prepare' }
          : result;
    },
  });
  homes.answer(serverId, 'GET /v1/projects/sources', {
    body: {
      ok: true,
      sources: [{ id: 'storefront', revision: 3, name: 'storefront', audience: [], createdByAccountId: 'owner' }],
      coverage: { complete: true, nextCursor: null },
    },
  });
  const creations: Record<string, unknown>[] = [];
  const createMode = { value: 'created' as 'created' | 'refused' | 'approval' | 'domainRouteRequired' | 'needsReview' | 'ownerDenied' };
  const templateHost = async (raw: unknown) => {
      const input = DeploymentTemplateInstantiateInputV1Schema.parse(raw);
      // The same template owner previews and applies the Store install through the real Action front door.
      if (input.mode === 'preview') {
        const creationDefaults = { values: { controllerMachineId: 'target', retainPreviousDeployments: 2 },
          sources: { controllerMachineId: 'account', retainPreviousDeployments: 'builtin' } } as const;
        // A new Project has no Source yet, so its review carries no Source defaults basis.
        const basis = input.projectSourceId
          ? { creationDefaultsBasis: { projectSourceId: input.projectSourceId, sourceRevision: 3, projectDefaultsRevision: 0, content: null } }
          : {};
        const preview = DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'preview',
          review: { templateRef: input.templateRef,
            profiles: app.compose.profiles, services: app.compose.services, bindings: [], generatedSecrets: [],
            domains: options.receivingTemplate ? app.domains.flatMap(domain => {
              const binding = input.domainBindings?.find(binding => binding.templateDomainId === domain.key);
              return binding ? [{ ...domain, hostname: binding.hostname }] : [];
            }) : [],
            firstRunSetup: app.firstRunSetup, creationDefaults, ...basis,
            ...(input.environment.kind === 'create' && app.domains.some(domain => domain.required)
              ? { deploy: { requestKey: input.environment.requestKey } } : {}) } });
        return preview;
      }
      creations.push(input as Record<string, unknown>);
      return createMode.value === 'domainRouteRequired'
            ? { ok: false, errorCode: 'template_domain_route_required', error: 'template_domain_route_required' }
            : createMode.value === 'needsReview'
            ? { ok: false, errorCode: 'template_needs_review', error: 'template_needs_review' }
            : createMode.value === 'ownerDenied'
            ? { ok: false, errorCode: 'deployment_access_denied', error: 'deployment_access_denied' }
            : createMode.value === 'refused'
            ? { ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable' }
            : createMode.value === 'approval'
              ? { kind: 'approval_request_created', artifactId: 'create-approval', actionId: 'deployments.templates.instantiate' }
              : DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'applied', environmentId: 'status-page', revision: 1,
                targetLinkId: 'target-link', savedSecrets: [],
                definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` } });
  };
  const readTemplateHostResult = async (input: unknown) => {
    const response = await templateHost(input);
    const refusal = ActionExecuteFailureSchema.safeParse(response);
    if (refusal.success) return refusal.data;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response);
    return approval.success ? approval.data : DeploymentTemplateInstantiateResultV1Schema.parse(response);
  };
  let receiver: ReturnType<typeof createActionExecutor> | null = null;
  const receiverOutcomes: { mode: 'preview' | 'apply'; ok: boolean; errorCode?: string; resultKind?: string }[] = [];
  const receiverAdmissions: unknown[] = [];
  const templateBoundary = await answerExternalActionAccountForHome(homes, serverId, {
    actionId: 'deployments.templates.instantiate', machineId: 'target', installationId: 'installed', tokenEpoch: 0, failure,
    ...(options.machineCatalogs ? { additionalMachines: [{ machineId: 'second-target', installationId: 'second-install' }] } : {}),
    execute: async (raw, transport) => {
      receiverAdmissions.push({ deploymentChildRoot: transport.authorization.binding.deploymentChildRoot,
        preparation: transport.authorization.binding.deploymentPreparationAdmission });
      if (!receiver) return templateHost(raw);
      if (!('authentication' in transport.authorization.binding) || !account.serverIdentityId)
        throw new Error('Expected the actual Account-authorized Home ingress');
      const result = await receiver.execute('deployments.templates.instantiate', raw, {
        surface: transport.invocation.surface,
        authority: transport.invocation.authority === 'present_user'
          ? resolveInvocationAuthority({ credential: transport.authorization.binding.authentication.kind,
            surface: transport.invocation.surface, actionId: 'deployments.templates.instantiate' })
          : transport.invocation.authority,
        actionCaller: transport.invocation.caller,
        presentUserConfirmation: transport.invocation.presentUserConfirmation,
        serverId, serverIdentityId: account.serverIdentityId, runtimeAccountId: account.accountId,
        externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
        originalActionEnvelope: transport.envelope, actionRequestId: transport.requestId,
        actionsSettings: resolveActionsSettingsV1FromState(storage.getState()),
        signExternalActionApprovalInput: ({ actionId, input, target, requesterConfirmation, sessionTargetsV1 }) =>
          templateBoundary.signApprovalInput({ authorizationToken: transport.authorization.token, actionId, input, target,
            ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
      });
      receiverOutcomes.push({ mode: DeploymentTemplateInstantiateInputV1Schema.parse(raw).mode, ok: result.ok,
        ...(!result.ok ? { errorCode: result.errorCode } : result.result && typeof result.result === 'object' && 'kind' in result.result && typeof result.result.kind === 'string'
          ? { resultKind: result.result.kind } : {}) });
      return result.ok ? result.result : result;
    },
  });
  // The created Environment as the Home reads it back: a new Project's Source exists only after apply.
  const createdEnvironment = createDeploymentEnvironmentHeaderV1({ serverId, id: 'status-page', projectSourceId: 'status-src' });
  homes.answer(serverId, `/v1/deployments/environments/${createdEnvironment.id}`, {
    body: { ok: true, environment: createdEnvironment, targetLinks: [] },
  });
  const account = await captureLazyActionAccountContext(serverId);
  if (options.receivingTemplate) receiver = createActionExecutor(createActionExecutorBoundaryFixture({
    resolveEnvironmentApprovalScope: createUiDeploymentActionDeps(account).resolveEnvironmentApprovalScope,
    // The installed host is the external template preparation/effect boundary.
    // Protocol preparation, child policy and exact confirmation admission remain real.
    prepareDeploymentTemplateInstantiation: async ({ input }) => {
      const preview = DeploymentTemplateInstantiateResultV1Schema.parse(await templateHost({ ...input, mode: 'preview' }));
      if (preview.kind !== 'preview') throw new Error('Expected template host preview');
      const prepared = DeploymentTemplateInstantiateInputV1Schema.parse({ ...input,
        ...(input.environment.kind === 'create' && input.deploy === undefined && preview.review.deploy
          ? { deploy: preview.review.deploy } : {}) });
      return { input: prepared, preview: projectNativeJsonValueForTransport(preview.review), hostReviewedChildren: {
        children: [...preview.review.domains.map(domain => ({ action: 'deployments.domains.add' as const,
          role: `template.domain:${domain.key}` })), ...(preview.review.deploy
          ? [{ action: 'deployments.deploy' as const, role: 'template.deploy' }] : [])],
        executeAdmittedAction: async () => {
          const result = await readTemplateHostResult(prepared);
          return 'errorCode' in result ? result : { ok: true as const, result };
        },
      } };
    },
    deploymentTemplateInstantiate: readTemplateHostResult,
    approvalsCreate: ({ request }) => createApprovalArtifact({ request, accountId: account.accountId,
      read: id => account.readArtifact(id, { fresh: true, ownerOnly: true }),
      create: async (artifactId, header, body, idScope) =>
        (await account.createArtifactDocument({ artifactId, header, body, idScope })).artifact }),
  }));
  storage.setState({
    settingsScope: account.accountLifetime.scope,
    profileScope: account.accountLifetime.scope,
  });
  // The listing host reads the active Registry Account, as the signed-in app does.
  const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
  const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
  storage.getState().activateProfileScope(account.accountLifetime.scope);
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
  const lifetime = captureActiveServerAccountScopeLifetime();
  if (!lifetime) throw new Error('active Account lifetime unavailable');
  storage
    .getState()
    .applyMachines(
      [
        createMachineFixture({
          id: 'target',
          installationId: 'installed',
          // Presence reads a recent heartbeat; the fixture default's activeAt reads as long offline.
          activeAt: Date.now(),
          metadata: {
            displayName: 'vps-1',
            host: 'vps-1',
            platform: 'linux',
            happyCliVersion: '0.3',
            happyHomeDir: '/home/a',
            homeDir: '/home/a',
          },
        }),
        ...(options.machineCatalogs ? [createMachineFixture({ id: 'second-target', installationId: 'second-install', activeAt: Date.now() })] : []),
        // A Machine that went offline: listed with its offline reason, never choosable.
        createMachineFixture({
          id: 'parked',
          installationId: 'parked-install',
          active: false,
          activeAt: 1,
          metadata: {
            displayName: 'old-vps',
            host: 'old-vps',
            platform: 'linux',
            happyCliVersion: '0.3',
            happyHomeDir: '/home/a',
            homeDir: '/home/a',
          },
        }),
      ],
      true,
      { sourceServerId: serverId },
    );
  // This fixture reviews the Store form and dispatched outcomes; seed the person's
  // real policy so the front door need not create an unrelated approval Artifact.
  await homes.setActionPolicy(serverId, ['deployments.publish.prepare', 'deployments.templates.instantiate'], 'ui', 'allowed');
  return {
    sourceId,
    account,
    lifetime,
    preparations,
    creations,
    receiverOutcomes,
    receiverAdmissions,
    createMode,
    mode,
    machineItems,
    dispose: () => account.dispose(),
  };
}

/** The review's one Machine field (New Session's Machine picker): choose one of its listed Machines, as a person picking from it does. */
function machineField(
  screen: Readonly<{ findAll: (predicate: (node: { props?: Record<string, unknown> }) => boolean) => { props: Record<string, unknown> }[] }>,
  testID = 'store.app.prepare.machine',
) {
  return screen.findAll((node) => node.props?.testID === testID && typeof node.props.onSelectMachine === 'function')[0];
}
async function chooseMachine(
  screen: Parameters<typeof machineField>[0],
  machineId: string,
) {
  const field = machineField(screen);
  expect(field).toBeDefined();
  const machine = (field!.props.machines as readonly { id: string }[]).find((entry) => entry.id === machineId);
  expect(machine).toBeDefined();
  await act(async () => { (field!.props.onSelectMachine as (machine: unknown) => void)(machine); });
}

/** The review's one Project field (more than four choices): choose through the select's own onSelect. */
function projectSelect(
  screen: Readonly<{ findAll: (predicate: (node: { props?: Record<string, unknown> }) => boolean) => { props: Record<string, unknown> }[] }>,
) {
  return screen.findAll((node) => node.props?.testID === 'store.app.prepare.project'
    && typeof node.props.onSelect === 'function' && Array.isArray(node.props.items))[0];
}
async function chooseProject(
  screen: Parameters<typeof projectSelect>[0],
  id: string,
) {
  const select = projectSelect(screen);
  expect(select).toBeDefined();
  await act(async () => { (select!.props.onSelect as (id: string) => void)(id); });
}
/** The first step's own answers: the Environment's name and each required address. */
async function nameIt(
  screen: Readonly<{ findHostByTestId: (id: string) => Parameters<typeof changeTextTestInstance>[0] | null | undefined }>,
  hostnames: Readonly<Record<string, string>> = { web: 'status.example.com' },
) {
  await act(async () => { changeTextTestInstance(screen.findHostByTestId('store.app.prepare.environmentName')!, 'Status page'); });
  for (const [key, hostname] of Object.entries(hostnames)) {
    await act(async () => { changeTextTestInstance(screen.findHostByTestId(`store.app.prepare.domain.${key}`)!, hostname); });
  }
}
const hasProjectChoice = (screen: Parameters<typeof projectSelect>[0], id: string) =>
  ((projectSelect(screen)?.props.items ?? []) as readonly { id: string }[]).some((item) => item.id === id);

it.each(['applied', 'domain-failure', 'lost-root-reply'] as const)('retains a confirmed install and its $0 result across review remounts', async outcome => {
  const { showStoreAppPreparation } = await import('./StoreAppPreparation');
  const { Modal } = await import('@/modal');
  const fixture = await createFixture();
  const installs: unknown[] = [];
  let finish: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const partial = DeploymentTemplateInstantiationPartialV1Schema.parse({ kind: 'partial', phase: 'domains',
    errorCode: 'native_effect_failed', environmentId: 'status-page', revision: 4, targetLinkId: 'target-link', savedSecrets: [],
    definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
    deployment: { ok: true, environmentId: 'status-page', revision: 4, deploymentId: 'deployed', deploymentRevision: 11, state: 'succeeded' } });
  let admitted: ReturnType<typeof DeploymentTemplateInstantiateInputV1Schema.parse> | undefined;
  const applied = { kind: 'applied', environmentId: 'status-page', revision: 4,
    targetLinkId: 'target-link', savedSecrets: [], definition: partial.definition };
  const operationReads: string[] = [];
  const { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
  const { readDeploymentTemplateCreationOperationRequestIdV1 } = await import('@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1');
  const rpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  // Only the lost HTTP reply case supplies the daemon's RPC replies; observation and its schemas stay real.
  const operationTransport = outcome === 'lost-root-reply' ? vi.spyOn(rpc, 'machineRpcWithServerScope').mockImplementation(
    createServerScopedMachineRpcBoundaryMock(async request => {
      if (!admitted) throw new Error('Expected an admitted install before operation observation');
      const requestId = readDeploymentTemplateCreationOperationRequestIdV1(admitted);
      const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'retained-install', revision: 1,
        requestId, actionId: 'deployments.templates.instantiate', state: 'running',
        scope: { accountId: fixture.lifetime.scope.accountId, machineId: 'target' },
        title: 'Install App', createdAt: 1, startedAt: 1, cancellation: 'unsupported' });
      operationReads.push(request.method);
      if (request.method === ACTION_OPERATION_RPC_METHODS_V2.list) {
        expect(request.payload).toMatchObject({ requestIdentity: { actionId: operation.actionId, requestId } });
        return { items: [operation], nextCursor: null };
      }
      if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) {
        expect(request.payload).toMatchObject({ operationId: operation.operationId, waitForTerminal: true });
        return { kind: 'found', operation: { ...operation, revision: 2, state: 'succeeded', settledAt: 2, result: applied } };
      }
      throw new Error(`Unexpected operation RPC: ${request.method}`);
    }).machineRpcWithServerScope,
  ) : undefined;
  await answerExternalActionAccountForHome(homes, fixture.lifetime.scope.serverId, {
    actionId: 'deployments.templates.instantiate', machineId: 'target', installationId: 'installed', tokenEpoch: 0,
    failure: result => ActionExecuteFailureSchema.safeParse(result).data ?? null,
    execute: async raw => {
      const input = DeploymentTemplateInstantiateInputV1Schema.parse(raw);
      if (input.mode === 'preview') return { kind: 'preview', review: { templateRef: input.templateRef,
        profiles: [], services: ['kuma'], bindings: [], generatedSecrets: [], domains: [], deploy: { requestKey: 'install-deploy' } } };
      installs.push(input);
      admitted = input;
      await pending;
      return outcome === 'lost-root-reply' ? { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }
        : outcome === 'domain-failure' ? partial : applied;
    },
  });
  let open: (() => void) | undefined;
  function Listing() {
    const ready = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true } });
    if (ready.kind === 'ready') open = () => { showStoreAppPreparation({ ready, lifetime: fixture.lifetime, name: 'Uptime Kuma' }); };
    return null;
  }
  const listing = await renderScreen(<Listing />);
  let review: Awaited<ReturnType<typeof renderScreen>> | undefined;
  const closed = vi.fn();
  try {
    await waitForHomeGovernance(() => expect(open).toBeTypeOf('function'));
    await act(async () => { open!(); });
    const config = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    const Component = config.component;
    const tree = (key: string) => <Component key={key} {...config.props} onClose={closed} />;
    review = await renderScreen(tree('wide'));
    await waitForHomeGovernance(() => expect(hasProjectChoice(review!, 'storefront')).toBe(true));
    await chooseMachine(review, 'target');
    await chooseProject(review, 'storefront');
    await nameIt(review);
    await review.pressByTestIdAsync('store.app.prepare.review');
    await waitForHomeGovernance(() => expect(review!.findHostByTestId('store.app.prepare.confirm')).toBeTruthy());
    await review.pressByTestIdAsync('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(installs).toHaveLength(1));
    await review.update(tree('phone'));
    expect(review.findHostByTestId('store.app.prepare.confirm')?.props.accessibilityState.disabled).toBe(true);
    expect(review.findHostByTestId('store.app.prepare.back')).toBeNull();
    expect(review.getTextContent()).not.toContain(t('capabilities.store.appPage.preparedTitle'));
    expect(review.getTextContent()).not.toContain(t('capabilities.store.appPage.prepareDescription'));
    await review.pressByTestIdAsync('store.app.prepare.confirm');
    expect(installs).toHaveLength(1);
    await act(async () => { finish!(); });
    if (outcome !== 'domain-failure') {
      await waitForHomeGovernance(() => expect(closed).toHaveBeenCalledOnce());
      expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining('deploymentEnvironment=status-page'));
      if (outcome === 'lost-root-reply') expect(operationReads).toContain(ACTION_OPERATION_RPC_METHODS_V2.get);
      expect(installs).toHaveLength(1);
    } else {
      await waitForHomeGovernance(() => expect(review!.findHostByTestId('store.app.prepare.progress')).toBeTruthy());
      await review.update(tree('wide-result'));
      expect(review.findHostByTestId('store.app.prepare.progress')).toBeTruthy();
      await review.pressByTestIdAsync('store.app.prepare.progress.failed.details');
      expect(review.getTextContent()).toContain('native_effect_failed');
      expect(review.getTextContent()).toContain(t('projects.deployments.review.environment'));
      expect(review.findHostByTestId('store.app.prepare.confirm')).toBeNull();
      expect(installs).toHaveLength(1);
      expect(closed).not.toHaveBeenCalled();
    }
  } finally {
    finish?.();
    await review?.unmount();
    await listing.unmount();
    operationTransport?.mockRestore();
    await fixture.dispose();
  }
});

it('installs from the person’s Store confirmation without a self-approval Artifact', async () => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const fixture = await createFixture([], { receivingTemplate: true });
  const serverId = fixture.lifetime.scope.serverId;
  await homes.requireActionApproval(serverId, 'deployments.templates.instantiate', 'ui');
  function Harness() {
    const state = useStoreAppListing({
      selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true },
    });
    return state.kind === 'ready'
      ? <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} /> : null;
  }
  const screen = await renderScreen(<Harness />);
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseMachine(screen, 'target');
    await chooseProject(screen, 'new');
    await act(async () => { changeTextTestInstance(screen.findHostByTestId('store.app.prepare.project.newName')!, 'Status'); });
    await nameIt(screen);
    await screen.pressByTestIdAsync('store.app.prepare.review');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.prepared')).toBeTruthy());
    await screen.pressByTestIdAsync('store.app.prepare.confirm');
    expect(homes.artifacts(serverId).list().length).toBe(0);
    expect(fixture.creations, JSON.stringify(fixture.receiverOutcomes)).toHaveLength(1);
    expect(fixture.creations[0]).toMatchObject({ mode: 'apply',
      newProject: { name: 'Status', owner: { kind: 'account', accountId: 'owner' } },
      environment: { kind: 'create', name: 'Status page' }, deploy: { requestKey: expect.any(String) } });
    // The actual Home boundary must sign first-deploy intent before the receiver
    // starts receipt-history reads, even when original UI dispatch skips preparation.
    expect(fixture.receiverAdmissions).toEqual([{ deploymentChildRoot: true,
      preparation: expect.objectContaining({ operation: 'template', mode: 'apply',
        deploy: DeploymentTemplateInstantiateInputV1Schema.parse(fixture.creations[0]).deploy }) }]);
    expect(fixture.creations[0]).not.toHaveProperty('projectSourceId');
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('shows the ports and names the App declares in the person’s install review (#4)', async () => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const fixture = await createFixture([], { ports: true });
  function Harness() {
    const state = useStoreAppListing({
      selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true },
    });
    return state.kind === 'ready'
      ? <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} /> : null;
  }
  const screen = await renderScreen(<Harness />);
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseMachine(screen, 'target');
    await chooseProject(screen, 'new');
    await act(async () => { changeTextTestInstance(screen.findHostByTestId('store.app.prepare.project.newName')!, 'Status'); });
    await nameIt(screen);
    await screen.pressByTestIdAsync('store.app.prepare.review');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.ports')).toBeTruthy());
    const ports = screen.findHostByTestId('store.app.prepare.ports')!;
    const text = JSON.stringify(ports.findAll(() => true).map(node => node.props.children).filter(child => typeof child === 'string'));
    expect(text).toContain('3001:3001');
    expect(text).toContain('kuma-1');
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it.each([null, 'MIT'])('supplies the exact catalog pin, literal image tag and optional licence %s for Versions', async license => {
  const { StoreAppListing } = await import('./StoreAppListing');
  const fixture = await createFixture([], license ? { machineCatalogs: true, catalogLicense: license } : {});
  const captured: { listing?: ReturnType<typeof useStoreAppListing> } = {};
  function Listing() {
    const state = useStoreAppListing({
      selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true },
      ...(license ? { installMachineId: 'target' } : {}),
    });
    captured.listing = state;
    return state.kind === 'ready' ? <StoreAppListing state={state} lifetime={fixture.lifetime}
      pushed={false} onClose={() => {}} /> : null;
  }
  const screen = await renderScreen(<Listing />);
  try {
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.listing:primary')).toBeTruthy());
    const { listing } = captured;
    if (listing?.kind !== 'ready') throw new Error('Expected the selected App listing');
    const ref = listing.templateRef.ref;
    if (ref.kind !== 'content') throw new Error('Expected the catalog content digest');
    expect(listing).toMatchObject({ catalogRef: listing.templateRef.ref, imageTag: '2', license });
    expect(screen.findHostByTestId('store.app.listing.versions')).toBeTruthy();
    expect(screen.getTextContent()).toContain(ref.digest);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('opens an App through the Store listing body in its native ready, needs-review and unavailable states', async () => {
  const fixture = await createFixture();
  const body = (itemId: string) => (
    <StoreListingBody
      presentation="page"
      onClose={() => {}}
      reference={{
        type: 'registryItem',
        kind: 'app',
        sourceId: fixture.sourceId,
        itemId,
      }}
    />
  );
  const screen = await renderScreen(body('uptime-kuma'));
  try {
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('store.app.listing:primary')).toBeTruthy(),
    );
    const text = screen.getTextContent();
    expect(text).toContain('Uptime Kuma');
    // The App's own facts: its address and the first-run admin, never a generic "unavailable".
    expect(screen.findHostByTestId('store.app.listing.domain.web')).toBeTruthy();
    expect(screen.findHostByTestId('store.app.listing.firstRun')).toBeTruthy();
    expect(screen.findHostByTestId('store.listing.unavailable')).toBeFalsy();
    expect(fixture.preparations).toEqual([]);

    await screen.update(body('needs-review'));
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('store.app.listing.review')).toBeTruthy(),
    );
    expect(
      screen.findHostByTestId('store.app.listing:primary')?.props
        .accessibilityHint,
    ).toBeTruthy();

    // An App its source can't serve says why (the source's typed reason), with Retry.
    await screen.update(body('missing'));
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('store.listing.failed')).toBeTruthy(),
    );
    expect(fixture.preparations).toEqual([]);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('keeps the selected App and its open install sheet when its pane becomes phone-sized', async () => {
  const { Modal } = await import('@/modal');
  const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
  const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
  const { StoreListingPaneHost } = await import('./StoreListing');
  const fixture = await createFixture();
  const reference = { type: 'registryItem', kind: 'app', sourceId: fixture.sourceId, itemId: 'uptime-kuma' } as const;
  const navigation = { push: vi.fn(), pushRetainingCurrent: vi.fn(), replace: vi.fn(), back: vi.fn(), setParams: vi.fn() };
  const tree = () => <DestinationInstanceHost tabId="store" ref={{ kind: 'plugins', params: { selection: JSON.stringify(reference) } }}
    pathname="/plugins" focused visible navigation={navigation}>
    <AppPaneProvider><StoreListingPaneHost title="Store" testID="store">
      {React.createElement('View', { testID: 'store.directory' })}
    </StoreListingPaneHost></AppPaneProvider>
  </DestinationInstanceHost>;
  const show = vi.mocked(Modal.show);
  const hide = vi.mocked(Modal.hide);
  show.mockClear(); hide.mockClear();
  const screen = await renderScreen(tree());
  try {
    await waitForHomeGovernance(async () => {
      const primary = screen.findHostByTestId('store.app.listing:primary');
      expect(primary).toBeTruthy();
      await act(async () => { await primary!.props.onPress?.(); });
      expect(show).toHaveBeenCalledTimes(1);
    });
    const listing = screen.findHostByTestId('store.app.listing:primary');
    viewport.width = 390;
    await screen.update(tree());
    await act(async () => {
      const host = screen.root.findAllByType('View').find(node => typeof node.props.onLayout === 'function');
      expect(host).toBeDefined();
      host!.props.onLayout({ nativeEvent: { layout: { width: viewport.width, height: viewport.height } } });
    });
    await flushHookEffects();
    expect(screen.findHostByTestId('store.app.listing:primary')).toBe(listing);
    expect(hide).not.toHaveBeenCalled();
    expect(navigation.pushRetainingCurrent).not.toHaveBeenCalled();
    expect(screen.findByTestId('multi-pane-details-modal')).not.toBeNull();
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('withdraws the install sheet when its listing stops being presented (a route change away from it)', async () => {
  const { Modal } = await import('@/modal');
  const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
  const fixture = await createFixture();
  const navigation = { push: () => {}, pushRetainingCurrent: () => {}, replace: () => {}, back: () => {} };
  const tree = (visible: boolean) => (
    <DestinationInstanceHost tabId="store" ref={{ kind: 'plugins', params: {} }} pathname="/plugins" focused visible={visible}
      navigation={navigation}>
      <StoreListingBody presentation="page" onClose={() => {}}
        reference={{ type: 'registryItem', kind: 'app', sourceId: fixture.sourceId, itemId: 'uptime-kuma' }} />
    </DestinationInstanceHost>
  );
  const show = vi.mocked(Modal.show);
  const hide = vi.mocked(Modal.hide);
  show.mockClear();
  hide.mockClear();
  const screen = await renderScreen(tree(true));
  try {
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.listing:primary')?.props.accessibilityHint).toBeFalsy());
    await waitForHomeGovernance(async () => {
      await act(async () => { await screen.findHostByTestId('store.app.listing:primary')!.props.onPress?.(); });
      expect(show).toHaveBeenCalledTimes(1);
    });
    const sheetId = show.mock.results[0]!.value as string;
    expect(hide).not.toHaveBeenCalled();
    await screen.update(tree(false));
    await flushHookEffects();
    expect(hide).toHaveBeenCalledWith(sheetId);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('defers each kind until presented and recovers a retained missing-plugin item through the same dispatcher', async () => {
  const fixture = await createFixture();
  const body = (kind: string, presented: boolean) => <StoreKindSurface kind={kind} mode="listing" presented={presented}
    selection={{ sourceId: fixture.sourceId, itemId: 'uptime-kuma' }} pushed={false} size="page" onClose={() => {}} />;
  const screen = await renderScreen(body('app', false));
  try {
    await flushHookEffects();
    expect(screen.findHostByTestId('store.app.listing:primary')).toBeFalsy();
    expect(screen.getTextContent()).toBe('');
    await screen.update(body('app', true));
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.listing:primary')).toBeTruthy());
    await screen.update(body('example.themes/themes', false));
    await flushHookEffects();
    expect(screen.getTextContent()).toBe('');
    await screen.update(body('example.themes/themes', true));
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.kind.unavailable')).toBeTruthy());
    const recovery = screen.findAll(node => node.props.accessibilityLabel === t('settingsPlugins.managePlugin')
      && typeof node.props.onPress === 'function')[0];
    expect(recovery).toBeDefined();
    await act(async () => { await recovery!.props.onPress?.(); });
    expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(buildPluginDetailRoute('settings', 'example.themes'));
    expect(fixture.preparations).toEqual([]);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('hands both preparation Machine fields every Machine with linear name reads', async () => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  async function measure(machineCount: number) {
    const fixture = await createFixture();
    let nameReads = 0;
    const machines = Array.from({ length: machineCount }, (_, index) => createMachineFixture({
      id: `menu-machine-${index}`,
      installationId: `menu-installation-${index}`,
      activeAt: Date.now(),
      metadata: {
        get displayName() { nameReads += 1; return index < 2 ? 'Shared name' : `Machine ${index}`; },
        host: `host-${index}`, platform: 'linux', happyCliVersion: '0.3',
        happyHomeDir: '/home/a', homeDir: '/home/a',
      },
    }));
    storage.getState().applyMachines(machines, true, { sourceServerId: fixture.lifetime.scope.serverId });
    nameReads = 0;
    function Harness() {
      const state = useStoreAppListing({
        selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.lifetime, demand: { presented: true },
      });
      return state.kind === 'ready'
        ? <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} /> : null;
    }
    const screen = await renderScreen(<Harness />);
    try {
      await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.review')).toBeTruthy());
      // Both fields hand every Machine to New Session's picker, which names and qualifies them (its own suite).
      expect((machineField(screen)!.props.machines as readonly unknown[])).toHaveLength(machineCount);
      await act(async () => {
        screen.findAll(node => node.props.testID === 'store.app.prepare.options'
          && typeof node.props.onExpandedChange === 'function')[0]!.props.onExpandedChange(true);
      });
      expect((machineField(screen, 'store.app.prepare.controller')!.props.machines as readonly unknown[])).toHaveLength(machineCount);
      return nameReads;
    } finally {
      await screen.unmount();
      await fixture.dispose();
    }
  }
  const small = await measure(128);
  const large = await measure(256);
  expect(small).toBeGreaterThan(0);
  // Twice as many actual rows may read twice as many names, never four times as many peers.
  expect({ small, large }).toEqual({ small, large: small * 2 });
});

it('keeps typed template values and volume names through review without writing on input', async () => {
  const fixture = await createFixture([], { domains: [], templateInputs: true });
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  function Harness() {
    const state = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true } });
    return state.kind === 'ready' ? <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} /> : null;
  }
  const screen = await renderScreen(<Harness />);
  const press = async (testID: string) => {
    await act(async () => { await screen.findHostByTestId(testID)!.props.onPress?.(); });
  };
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    const userId = 'store.app.prepare.choices.variable.APP_USER';
    const volumeId = 'store.app.prepare.choices.volume.data';
    expect(screen.findHostByTestId(userId)?.props.accessibilityLabel).toBe('App user');
    expect(screen.findHostByTestId('store.app.prepare.choices.variable.INTERNAL_APP_REGION')?.props.accessibilityLabel)
      .toBe(t('projects.deployments.sourceValue'));
    await act(async () => { changeTextTestInstance(screen.findHostByTestId(userId)!, 'alice'); });
    await act(async () => { changeTextTestInstance(screen.findHostByTestId(volumeId)!, 'status-data'); });
    // An optional companion is a reviewed choice like any other input: off until switched on.
    await act(async () => { screen.root.findAll(node => node.props.testID === 'store.app.prepare.choices.companion.sidecar'
      && typeof node.props.onValueChange === 'function')[0]!.props.onValueChange(true); });
    expect(fixture.preparations).toEqual([]);
    expect(fixture.creations).toEqual([]);
    await chooseMachine(screen, 'target');
    await chooseProject(screen, 'storefront');
    expect(screen.findHostByTestId('store.app.prepare.environmentName')?.props.placeholder).toBe('Uptime Kuma');
    await nameIt(screen, {});
    await press('store.app.prepare.review');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.prepared')).toBeTruthy());
    await press('store.app.prepare.back');
    expect(screen.findHostByTestId(userId)!.props.value).toBe('alice');
    expect(screen.findHostByTestId(volumeId)!.props.value).toBe('status-data');
    await press('store.app.prepare.review');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.prepared')).toBeTruthy());
    await press('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(fixture.creations).toHaveLength(1));
    expect(fixture.creations[0]).toMatchObject({
      bindings: [{ name: 'APP_USER', source: { kind: 'value', value: 'alice' } }],
      volumeBindings: [{ templateVolumeId: 'data', source: 'status-data' }],
      companions: ['sidecar'],
    });
  } finally { await screen.unmount(); await fixture.dispose(); }
});

it.each(['none', 'optional', 'required'] as const)('reviews an App using its declared %s public-route requirement', async requirement => {
  const fixture = await createFixture([], { domains: requirement === 'none' ? [] : [{
    key: 'web', service: 'kuma', containerPort: 3001, protocol: 'https', required: requirement === 'required',
  }] });
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  function Harness() {
    const state = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true } });
    return state.kind === 'ready' ? <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} /> : null;
  }
  const screen = await renderScreen(<Harness />);
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseMachine(screen, 'target');
    await chooseProject(screen, 'storefront');
    await nameIt(screen, {});
    if (requirement === 'required') {
      expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
      expect(screen.getTextContent()).toContain(t('capabilities.store.appPage.domainRequired'));
      await act(async () => { changeTextTestInstance(screen.findHostByTestId('store.app.prepare.domain.web')!, '   '); });
      expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
      await nameIt(screen, { web: 'status.example.com' });
    }
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(false);
    await act(async () => { await screen.findHostByTestId('store.app.prepare.review')!.props.onPress?.(); });
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.prepared')).toBeTruthy());
    expect(fixture.preparations).toHaveLength(1);
    expect(fixture.creations).toEqual([]);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('prepares the exact App only on the person’s review and shows prepared, refused and approval outcomes in place', async () => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const fixture = await createFixture();
  function Harness() {
    const state = useStoreAppListing({
      selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime,
      demand: { presented: true },
    });
    return state.kind === 'ready' ? (
      <StoreAppPreparationReview
        ready={state}
        lifetime={fixture.lifetime}
        onClose={() => {}}
      />
    ) : null;
  }
  const screen = await renderScreen(<Harness />);
  try {
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('store.app.prepare.review')).toBeTruthy(),
    );
    expect(fixture.preparations).toEqual([]);
    // An offline Machine is listed by New Session's Machine picker, which disables it with its presence line.
    const field = machineField(screen)!;
    expect((field.props.machines as readonly { id: string }[]).map((entry) => entry.id)).toEqual(expect.arrayContaining(['parked', 'target']));
    expect(field.props.awayMachinesChoosable).toBeFalsy();
    // Even if chosen, an offline Machine never admits Review.
    await chooseMachine(screen, 'parked');
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    await chooseMachine(screen, 'target');
    expect(hasProjectChoice(screen, 'new')).toBe(true);
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseProject(screen, 'storefront');
    // The first step says what its Review still waits for, in words anyone can read.
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain(t('capabilities.store.appPage.nameEnvironment'));
    await nameIt(screen);
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(false);
    expect(screen.getTextContent()).not.toContain(t('capabilities.store.appPage.nameEnvironment'));
    await act(async () => {
      await screen
        .findHostByTestId('store.app.prepare.review')!
        .props.onPress?.();
    });
    await waitForHomeGovernance(() =>
      expect(
        screen.findHostByTestId('store.app.prepare.prepared'),
      ).toBeTruthy(),
    );
    // Review only reviews: nothing left to fill in, Install is ready, and it shows what was entered.
    expect(screen.findHostByTestId('store.app.prepare.environmentName')).toBeFalsy();
    expect(screen.findHostByTestId('store.app.prepare.domain.web')).toBeFalsy();
    expect(screen.findHostByTestId('store.app.prepare.confirm')!.props.disabled).toBeFalsy();
    expect(screen.getTextContent()).toContain('status.example.com');
    expect(screen.getTextContent()).toContain('Status page');
    expect(fixture.preparations).toHaveLength(1);
    expect(fixture.preparations[0]).toMatchObject({
      machineId: 'target',
      installationId: 'installed',
      projectSourceId: 'storefront',
      sourceRevision: 3,
    });
    expect(fixture.preparations[0]).not.toHaveProperty('newProject');
    // A first-run App warns in amber that whoever reaches it first can create its admin (lab addapp reviewFirstRun).
    expect(screen.findHostByTestId('store.app.prepare.firstRunWarning')).toBeTruthy();
    expect(fixture.preparations[0]).not.toHaveProperty('explicit');

    await act(async () => {
      screen.findHostByTestId('store.app.prepare.back')!.props.onPress?.();
    });
    fixture.mode.value = 'refused';
    const failureDetails = { requiredFact: 'routeUpstreams' };
    fixture.mode.failure = { ok: false, errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable', details: failureDetails };
    await act(async () => {
      await screen
        .findHostByTestId('store.app.prepare.review')!
        .props.onPress?.();
    });
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('store.app.prepare.refused')).toBeTruthy(),
    );
    expect(
      screen.findHostByTestId('store.app.prepare.refused')!.props,
    ).toBeTruthy();
    expect(screen.findHostByTestId('store.app.prepare.prepared')).toBeFalsy();
    expect(screen.getTextContent()).toContain(projectDeploymentFailureRecoveryV1(failureDetails, 'required_fact_unavailable').remedy);
    expect(screen.getTextContent()).not.toContain('required_fact_unavailable');

    fixture.mode.value = 'approval';
    await act(async () => {
      await screen
        .findHostByTestId('store.app.prepare.review')!
        .props.onPress?.();
    });
    await flushHookEffects();
    await waitForHomeGovernance(() =>
      expect(
        screen.findHostByTestId('store.app.prepare.approval'),
      ).toBeTruthy(),
    );
    expect(screen.findHostByTestId('store.app.prepare.refused')).toBeFalsy();
    // No auto-replay: the approval outcome never re-sends the preparation.
    expect(fixture.preparations).toHaveLength(3);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it.each([
  { name: 'one address', addresses: [{ service: 'uptime-kuma', port: 3001, label: 'Address' }] },
  { name: 'different services', addresses: [
    { service: 'uptime-kuma', port: 3001, label: 'Address for uptime-kuma' },
    { service: 'dashboard', port: 8080, label: 'Address for dashboard' },
  ] },
  { name: 'shared services', addresses: [
    { service: 'uptime-kuma', port: 3001, label: 'Address for uptime-kuma:3001' },
    { service: 'uptime-kuma', port: 3002, label: 'Address for uptime-kuma:3002' },
    { service: 'dashboard', port: 8080, label: 'Address for dashboard' },
  ] },
])('names $name by its service and explains DNS without exposing binding keys', async ({ addresses }) => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const domains = addresses.map(({ service, port }, index) => ({
    key: `SERVICE_URL_${index}_INTERNAL`, service, containerPort: port, protocol: 'https' as const, required: true,
    healthCheck: { path: '/', expectStatus: 200 },
  }));
  const fixture = await createFixture([], { domains });
  function Harness() {
    const state = useStoreAppListing({
      selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime,
      demand: { presented: true },
    });
    return state.kind === 'ready' ? (
      <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} />
    ) : null;
  }
  const screen = await renderScreen(<Harness />);
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseMachine(screen, 'target');
    await chooseProject(screen, 'storefront');
    for (const [index, address] of addresses.entries()) {
      const field = screen.findHostByTestId(`store.app.prepare.domain.${domains[index]!.key}`)!;
      expect(field.props.accessibilityLabel).toBe(address.label);
      expect(field.props.placeholder).toBe('example.com');
      const helper = `Point this name's DNS at the Machine; Happier routes it to ${address.service} on port ${address.port}`;
      expect(field.props.accessibilityHint).toBe(helper);
      expect(screen.getTextContent()).toContain(helper);
      expect(screen.getTextContent()).not.toContain(domains[index]!.key);
    }
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('requires every template hostname, omits empty optional domains and preserves typed create refusals and approval', async () => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
  const fixture = await createFixture([{ key: 'admin', required: true }, { key: 'extra', required: false }]);
  const pushed: unknown[] = [];
  let closed = 0;
  const push = (value: unknown) => { pushed.push(value); };
  function Harness() {
    const state = useStoreAppListing({
      selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime,
      demand: { presented: true },
    });
    return state.kind === 'ready' ? (
      <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => { closed += 1; }} />
    ) : null;
  }
  const screen = await renderScreen(
    <DestinationInstanceHost tabId="store" ref={{ kind: 'plugins', params: {} }} pathname="/plugins" focused visible
      navigation={{ push, pushRetainingCurrent: push, replace: () => {}, back: () => {} }}>
      <Harness />
    </DestinationInstanceHost>,
  );
  const press = async (testID: string) => {
    await act(async () => { await screen.findHostByTestId(testID)!.props.onPress?.(); });
  };
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseMachine(screen, 'target');
    await chooseProject(screen, 'storefront');
    for (const key of ['web', 'admin', 'extra']) {
      expect(screen.findHostByTestId(`store.app.prepare.domain.${key}`)).toBeTruthy();
    }
    const typeHostname = async (key: string, hostname: string) => {
      await act(async () => {
        changeTextTestInstance(screen.findHostByTestId(`store.app.prepare.domain.${key}`)!, hostname);
      });
    };
    const reviewAgain = async () => {
      await press('store.app.prepare.back');
    };
    const toReview = async () => {
      await press('store.app.prepare.review');
      await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.prepared')).toBeTruthy());
    };
    // Nothing is chosen for the person: Review waits for the Environment's name and each required address, and says so.
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain(t('capabilities.store.appPage.nameEnvironment'));
    await act(async () => { changeTextTestInstance(screen.findHostByTestId('store.app.prepare.environmentName')!, 'Status page'); });
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain(t('capabilities.store.appPage.domainRequired'));
    await typeHostname('web', 'status.example.com');
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    await typeHostname('admin', 'https://admin.example.com');
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    expect(screen.findHostByTestId('store.app.prepare.domain.admin.error')).toBeTruthy();
    expect(fixture.preparations).toEqual([]);
    await typeHostname('admin', 'admin.example.com');
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(false);
    await toReview();
    fixture.createMode.value = 'needsReview';
    await press('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(screen.findAll(node => node.props?.testID === 'store.app.prepare.refused'
      && node.props.diagnosticCode === 'template_needs_review')).not.toHaveLength(0));
    expect(pushed).toEqual([]);
    expect(fixture.creations[0]?.domainBindings).toEqual([
      { templateDomainId: 'web', hostname: 'status.example.com' }, { templateDomainId: 'admin', hostname: 'admin.example.com' },
    ]);
    // Back keeps what was typed, so a refused address is corrected where it was entered.
    await reviewAgain();
    expect(screen.findHostByTestId('store.app.prepare.environmentName')!.props.value).toBe('Status page');
    await typeHostname('admin', 'admin.example.com');
    await typeHostname('extra', 'https://extra.example.com');
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    await typeHostname('extra', '');
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(false);
    await toReview();

    fixture.createMode.value = 'domainRouteRequired';
    await press('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.refused')).toBeTruthy());
    expect(pushed).toEqual([]);
    expect(screen.findAll(node => node.props?.testID === 'store.app.prepare.refused'
      && node.props.diagnosticCode === 'template_domain_route_required')).not.toHaveLength(0);
    expect(fixture.creations).toHaveLength(2);
    expect(fixture.creations[1]?.domainBindings).toEqual([
      { templateDomainId: 'web', hostname: 'status.example.com' }, { templateDomainId: 'admin', hostname: 'admin.example.com' },
    ]);
    await flushHookEffects();
    expect(fixture.creations).toHaveLength(2);

    await reviewAgain();
    await typeHostname('extra', 'extra.example.com');
    await toReview();
    fixture.createMode.value = 'created';
    await press('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(pushed).toHaveLength(1));
    expect(closed).toBe(1);
    const href = new URL(String(pushed[0]), 'https://ui.test');
    expect(decodeURIComponent(href.pathname)).toBe('/deployments/storefront');
    expect(href.searchParams.get('deploymentEnvironment')).toBe('status-page');
    expect(fixture.creations.at(-1)).toMatchObject({ projectSourceId: 'storefront',
      environment: { kind: 'create', name: 'Status page', protection: 'nonProduction', deployerMode: 'managers' },
      templateRef: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      domainBindings: [{ templateDomainId: 'web', hostname: 'status.example.com' }, { templateDomainId: 'admin', hostname: 'admin.example.com' },
        { templateDomainId: 'extra', hostname: 'extra.example.com' }] });

    // An approval the create needs is answered in place; Confirm waits while it is open and nothing navigates.
    fixture.createMode.value = 'approval';
    await press('store.app.prepare.confirm');
    await flushHookEffects();
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.approval')).toBeTruthy());
    expect(screen.findHostByTestId('store.app.prepare.confirm')!.props.disabled).toBe(true);
    expect(pushed).toHaveLength(1);
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});

it('creates the App in the chosen new Project and retains its acknowledged Environment across a failed Source lookup', async () => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
  const fixture = await createFixture([], { teams: true });
  const pushed: unknown[] = [];
  const push = (value: unknown) => { pushed.push(value); };
  function Harness() {
    const state = useStoreAppListing({
      selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime,
      demand: { presented: true },
    });
    return state.kind === 'ready' ? (
      <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} />
    ) : null;
  }
  const screen = await renderScreen(
    <DestinationInstanceHost tabId="store" ref={{ kind: 'plugins', params: {} }} pathname="/plugins" focused visible
      navigation={{ push, pushRetainingCurrent: push, replace: () => {}, back: () => {} }}>
      <Harness />
    </DestinationInstanceHost>,
  );
  const press = async (testID: string) => {
    await act(async () => { await screen.findHostByTestId(testID)!.props.onPress?.(); });
  };
  const type = async (testID: string, value: string) => {
    await act(async () => { changeTextTestInstance(screen.findHostByTestId(testID)!, value); });
  };
  try {
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.review')).toBeTruthy());
    // Each select shows its value, or what to choose, never only its label.
    expect(screen.getTextContent()).toContain(t('capabilities.store.softwarePage.chooseMachine'));
    expect(screen.getTextContent()).toContain(t('capabilities.store.appPage.controllerDefault'));
    await chooseMachine(screen, 'target');
    await nameIt(screen);
    // New project is one choice of the Project field: it asks for a name and an owner, and Review waits for the name.
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    expect(hasProjectChoice(screen, 'new')).toBe(true);
    await chooseProject(screen, 'new');
    expect(screen.getTextContent()).toContain(t('capabilities.store.appPage.projectNew'));
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    await type('store.app.prepare.project.newName', '   ');
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(true);
    await type('store.app.prepare.project.newName', 'Status');
    // The name and Owner sit directly beneath the Project field, in the same section.
    const projectGroup = screen.findAll((node) => node.props?.testID === 'store.app.prepare.project.group')[0]!;
    expect(projectGroup.findAll((node) => node.props?.testID === 'store.app.prepare.project')).not.toHaveLength(0);
    expect(projectGroup.findAll((node) => node.props?.testID === 'store.app.prepare.project.newName')).not.toHaveLength(0);
    expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(false);
    // The owner offers the person's own Account and the Teams they belong to.
    await waitForHomeGovernance(() => {
      const items = screen.findAll((node) => node.props?.testID === 'store.app.prepare.project.owner'
        && Array.isArray(node.props.items))[0]?.props.items as readonly { id: string }[] | undefined;
      expect(items?.map((item) => item.id)).toEqual(['account', 'team:team-ops']);
    });
    const ownerSelect = screen.findAll((node) => node.props?.testID === 'store.app.prepare.project.owner'
      && typeof node.props.onSelect === 'function')[0]!;
    await act(async () => { (ownerSelect.props.onSelect as (id: string) => void)('team:team-ops'); });

    await press('store.app.prepare.review');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.prepared')).toBeTruthy());
    expect(fixture.preparations).toHaveLength(1);
    const prepared = fixture.preparations[0]!;
    expect(prepared).not.toHaveProperty('projectSourceId');
    expect(prepared).not.toHaveProperty('sourceRevision');
    expect(prepared.newProject).toMatchObject({ name: 'Status', owner: { kind: 'team', teamId: 'team-ops' } });
    expect(prepared.newProject?.requestKey).toEqual(expect.any(String));

    // The owner's typed refusal (here: not allowed to create in that Team) is shown as is, and nothing navigates.
    fixture.createMode.value = 'ownerDenied';
    await press('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(screen.findAll(node => node.props?.testID === 'store.app.prepare.refused'
      && node.props.diagnosticCode === 'deployment_access_denied')).not.toHaveLength(0));
    expect(screen.getTextContent()).toContain(projectDeploymentFailureRecoveryV1({}, 'deployment_access_denied').remedy);
    expect(screen.getTextContent()).not.toContain('deployment_access_denied');
    expect(pushed).toEqual([]);
    expect(fixture.creations.at(-1)).not.toHaveProperty('projectSourceId');
    expect(fixture.creations.at(-1)?.newProject).toEqual(prepared.newProject);

    fixture.createMode.value = 'created';
    const environmentPath = '/v1/deployments/environments/status-page';
    homes.answer(fixture.lifetime.scope.serverId, environmentPath, { status: 503, body: { error: 'service_unavailable' } });
    await press('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.created')).toBeTruthy());
    expect(screen.getTextContent()).toContain(t('projects.deployments.environmentCreated'));
    expect(screen.getTextContent()).toContain('status-page');
    expect(screen.findHostByTestId('store.app.prepare.confirm')).toBeNull();
    expect(screen.findHostByTestId('store.app.prepare.back')).toBeNull();
    expect(screen.getTextContent()).not.toContain(t('projects.deployments.createFailedTitle'));
    expect(pushed).toEqual([]);
    const createCount = fixture.creations.length;
    homes.answer(fixture.lifetime.scope.serverId, environmentPath, { body: { ok: true,
      environment: createDeploymentEnvironmentHeaderV1({ serverId: fixture.lifetime.scope.serverId,
        id: 'status-page', projectSourceId: 'status-src' }), targetLinks: [] } });
    await press('store.app.prepare.recover');
    await waitForHomeGovernance(() => expect(pushed).toHaveLength(1));
    expect(fixture.creations).toHaveLength(createCount);
    // The new Project's Source is known only once created; the page opens on the Environment the Home read back.
    const href = new URL(String(pushed[0]), 'https://ui.test');
    expect(decodeURIComponent(href.pathname)).toBe('/deployments/status-src');
    expect(href.searchParams.get('deploymentEnvironment')).toBe('status-page');
  } finally {
    await screen.unmount();
    await fixture.dispose();
  }
});


it('re-pins the App from each selected install Machine before preparing its review', async () => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const fixture = await createFixture([], { machineCatalogs: true });
  function Harness() {
    const state = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true } });
    return state.kind === 'ready' ? <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} /> : null;
  }
  const screen = await renderScreen(<Harness />);
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseProject(screen, 'storefront');
    await nameIt(screen);
    await chooseMachine(screen, 'second-target');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.review')?.props.disabled).toBe(false));
    await act(async () => { await screen.findHostByTestId('store.app.prepare.review')!.props.onPress(); });
    await waitForHomeGovernance(() => expect(fixture.preparations, screen.getTextContent()).toHaveLength(1));
    const item = fixture.machineItems.get('second-target')!;
    expect(item.payload.kind).toBe('app');
    expect(fixture.preparations[0]?.templateRef).toMatchObject({ version: item.summary.version,
      ref: item.payload.kind === 'app' && item.payload.state === 'ready' ? item.payload.ref : null });
    expect(screen.findHostByTestId('store.app.prepare.confirm')).toBeTruthy();
  } finally { await screen.unmount(); await fixture.dispose(); }
});

it.each(['target', 'parked', 'foreign-home'] as const)(
  'starts App preparation with the route Machine %s without overriding picker admission', async (choice) => {
    const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
    const fixture = await createFixture();
    const initialMachine = { serverId: choice === 'foreign-home' ? 'another-home' : fixture.lifetime.scope.serverId,
      machineId: choice === 'foreign-home' ? 'target' : choice };
    function Harness() {
      const state = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.lifetime, demand: { presented: true } });
      return state.kind === 'ready'
        ? <StoreAppPreparationReview ready={state} lifetime={fixture.lifetime} onClose={() => {}} {...{ initialMachine }} />
        : null;
    }
    const screen = await renderScreen(<Harness />);
    try {
      await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
      await chooseProject(screen, 'storefront');
      await nameIt(screen);
      const review = screen.findHostByTestId('store.app.prepare.review')!;
      expect(review.props.disabled).toBe(choice !== 'target');
      expect(fixture.preparations).toEqual([]);
      if (choice === 'target') {
        // The existing picker refuses an offline click and retains the person's valid seeded Machine.
        await chooseMachine(screen, 'parked');
        expect(screen.findHostByTestId('store.app.prepare.review')!.props.disabled).toBe(false);
        await act(async () => { await screen.findHostByTestId('store.app.prepare.review')!.props.onPress(); });
        await waitForHomeGovernance(() => expect(fixture.preparations).toHaveLength(1));
        expect(fixture.preparations[0]).toMatchObject({ serverId: fixture.lifetime.scope.serverId,
          machineId: 'target', installationId: 'installed' });
      }
    } finally {
      await screen.unmount();
      await fixture.dispose();
    }
  },
);


it.each([
  { name: 'forbidden Domain step', phase: 'domains', code: 'action_forbidden', state: 'succeeded', tab: 'domains' },
  { name: 'unknown deploy outcome', phase: 'deploy', code: 'outcome_unknown', state: 'outcome_unknown', tab: 'overview' },
] as const)('retains the created Environment after $name and opens recovery without another install', async scenario => {
  const { StoreAppPreparationReview } = await import('./StoreAppPreparation');
  const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
  const fixture = await createFixture();
  const serverId = fixture.lifetime.scope.serverId;
  const rpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
  const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
  // Observe the genuine RPC boundary: a returned partial must use its recovery, not join another root operation.
  const rootObservation = vi.spyOn(rpc, 'machineRpcWithServerScope');
  const partial = DeploymentTemplateInstantiationPartialV1Schema.parse({ kind: 'partial', phase: scenario.phase, errorCode: scenario.code,
    environmentId: 'status-page', revision: 4, targetLinkId: 'target-link', savedSecrets: [],
    definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
    deployment: { ok: true, environmentId: 'status-page', revision: 4, deploymentId: 'deployed', deploymentRevision: 11, state: scenario.state } });
  const installs: unknown[] = [];
  await answerExternalActionAccountForHome(homes, serverId, {
    actionId: 'deployments.templates.instantiate', machineId: 'target', installationId: 'installed', tokenEpoch: 0,
    failure: result => ActionExecuteFailureSchema.safeParse(result).data ?? null,
    execute: raw => {
      const input = DeploymentTemplateInstantiateInputV1Schema.parse(raw);
      if (input.mode === 'apply') installs.push(input);
      return input.mode === 'preview'
        ? { kind: 'preview', review: { templateRef: input.templateRef, profiles: [], services: ['kuma'],
            bindings: [], generatedSecrets: [], domains: [], deploy: { requestKey: 'install-deploy' } } }
        : { ok: false, errorCode: partial.errorCode, error: partial.errorCode, details: partial, effectAttempted: true };
    },
  });
  const pushed: unknown[] = [];
  const push = (value: unknown) => { pushed.push(value); };
  function Harness() {
    const ready = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
      lifetime: fixture.lifetime, demand: { presented: true } });
    return ready.kind === 'ready' ? <StoreAppPreparationReview ready={ready} lifetime={fixture.lifetime} onClose={() => {}} /> : null;
  }
  const screen = await renderScreen(<DestinationInstanceHost tabId="store" ref={{ kind: 'plugins', params: {} }} pathname="/plugins" focused visible
    navigation={{ push, pushRetainingCurrent: push, replace: () => {}, back: () => {} }}><Harness /></DestinationInstanceHost>);
  try {
    await waitForHomeGovernance(() => expect(hasProjectChoice(screen, 'storefront')).toBe(true));
    await chooseMachine(screen, 'target');
    await chooseProject(screen, 'storefront');
    await act(async () => {
      changeTextTestInstance(screen.findHostByTestId('store.app.prepare.environmentName')!, 'Bookmarks');
      changeTextTestInstance(screen.findHostByTestId('store.app.prepare.domain.web')!, 'bookmarks.example.com');
    });
    await screen.pressByTestIdAsync('store.app.prepare.review');
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.app.prepare.confirm')).toBeTruthy());
    await screen.pressByTestIdAsync('store.app.prepare.confirm');
    await waitForHomeGovernance(() => expect(installs).toHaveLength(1));
    await waitForHomeGovernance(() => {
      expect(rootObservation.mock.calls.filter(([request]) => request.method === ACTION_OPERATION_RPC_METHODS_V2.list)).toHaveLength(0);
      expect(screen.findAll(node => node.props.loading === true && node.props.testID === 'store.app.prepare.confirm')).toHaveLength(0);
    });
    expect(screen.findHostByTestId('store.app.prepare.progress')).toBeTruthy();
    expect(screen.getTextContent()).toContain(t('projects.deployments.review.environment'));
    expect(screen.getTextContent()).toContain(t(scenario.state === 'succeeded' ? 'projects.deployments.stateSucceeded' : 'projects.deployments.stateUnknown'));
    if (scenario.phase === 'domains') expect(screen.getTextContent()).toContain(t('projects.deployments.domainChangeFailedTitle'));
    expect(screen.findHostByTestId('store.app.prepare.confirm')).toBeNull();
    expect(screen.findHostByTestId('store.app.prepare.back')).toBeNull();
    await screen.pressByTestIdAsync('store.app.prepare.progress.failed.details');
    expect(screen.getTextContent()).toContain(scenario.code);
    await screen.pressByTestIdAsync('store.app.prepare.recover');
    await waitForHomeGovernance(() => expect(pushed).toHaveLength(1));
    expect(new URL(String(pushed[0]), 'https://ui.test').searchParams.get('deploymentTab')).toBe(scenario.tab);
    expect(installs).toHaveLength(1);
  } finally { await screen.unmount(); rootObservation.mockRestore(); await fixture.dispose(); }
});
