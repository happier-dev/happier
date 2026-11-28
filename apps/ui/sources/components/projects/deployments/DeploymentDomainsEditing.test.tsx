import * as React from 'react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeploymentReadControllerV1,
  type DeploymentDomainReadItemV1,
} from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { OwnServerDeploymentInputBasisV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import {
  act,
  createDeferred,
  standardCleanup,
  waitForTestEvent,
} from '@/dev/testkit';
import { t } from '@/text';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import {
  DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1,
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
  DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
  DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
} from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/deployment-protocol/v1';
import {
  ExternalActionRequestEnvelopeV1Schema,
  projectDeploymentReadAdmissionV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DEPLOYMENT_DOMAIN_DNS_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isJsonObject, StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { DomainIngressInspection } from './DeploymentDomainIngressFields';
import type { DeploymentDomainEditing } from './DeploymentDomainsPanel';

vi.mock('yaml', { spy: true });
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const routerMock = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routerMock.module);
// The exact controller RPC is the network boundary; its protocol reader stays real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: vi.fn(async () => {
      throw new Error('controller_unavailable');
    }),
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
// The person's choice in the shared Saved Secret picker is supplied at the sheet boundary.
const picked = vi.hoisted(() => ({ ref: '', resourceRevision: 4 }));
vi.mock(
  '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker',
  () => ({
    presentSavedSecretReferencePicker: vi.fn(async () => ({
      ref: picked.ref,
      resourceRevision: picked.resourceRevision,
    })),
  }),
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('expo/fetch', () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => homes.request(input, init) }));
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { createDeploymentActions } = await import('./deploymentActions');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>>;
let scope: typeof account.accountLifetime.scope & { projectSourceId: string };
let installedCloudflare: { dispose(): Promise<void> } | undefined;
let restoreDesktopFetch: (() => void) | undefined;
beforeEach(async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Domains Home', serverUrl: 'https://domains-home.test',
    serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'account-owner', currentAccount: true });
  account = await captureLazyActionAccountContext(serverId);
  scope = { ...account.accountLifetime.scope, projectSourceId: 'source-app' };
});
afterEach(async () => {
  await installedCloudflare?.dispose();
  installedCloudflare = undefined;
  restoreDesktopFetch?.();
  restoreDesktopFetch = undefined;
  account?.dispose();
  standardCleanup();
  (await import('./inlineAddDraft')).forgetInlineAddDraftsForTest();
});

const { DeploymentEnvironmentDetail } =
  await import('./DeploymentEnvironmentDetail');
const { PresentedDetailNavigationProvider } =
  await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');

const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };
const id = 'project-deployments.environment.domains.add';
type Detail = ReturnType<typeof createDeploymentEnvironmentDetailV1>;

function domain(
  domainId: string,
  hostname: string,
  extra: Partial<DeploymentDomainReadItemV1['content']> = {},
): DeploymentDomainReadItemV1 {
  return {
    domain: {
      v: 1 as const,
      id: domainId,
      environmentId: 'environment-staging',
      targetLinkId: 'target-link',
      revision: 1,
      state: 'active' as const,
      contentArtifactId: `content-${domainId}`,
      contentHeaderVersion: 1,
      contentBodyVersion: 1,
      createdByAccountId: 'account-owner',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    title: hostname,
    content: {
      hostname,
      target: { service: 'web', containerPort: 3000 },
      healthCheck: { path: '/', expectStatus: 200 },
      ...extra,
    },
  };
}

async function seedArtifact(artifactId: string, kind: string, title: string, body: unknown) {
  if (homes.artifacts(scope.serverId).list().some(artifact => artifact.id === artifactId)) return;
  await account.createArtifactDocument({ artifactId, header: { kind, title }, body: JSON.stringify(body) });
}

async function seedDomains(environmentId: string, items: readonly DeploymentDomainReadItemV1[]) {
  for (const { domain: header, content, title } of items) {
    await seedArtifact(header.contentArtifactId, DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, title, content);
  }
  homes.answer(scope.serverId, `GET /v1/deployments/environments/${environmentId}/domains`, {
    body: { ok: true, environmentId, revision: 1, domains: items.map(item => item.domain), nextCursor: null },
  });
}

function answerDomainHealth(environment: Detail['environment'], items: readonly DeploymentDomainReadItemV1[]) {
  const actionId = 'deployments.health.current';
  const path = `/v1/actions/${actionId}`;
  const { serverId, accountId } = scope;
  const input = { serverId, machineId: environment.controllerMachineId, environmentId: environment.id,
    targetLinkId: environment.runtimeTargetLinkId, domainIds: items.map(item => item.domain.id) };
  const bytes = Buffer.from(JSON.stringify({ ok: true, environmentId: input.environmentId, targetLinkId: input.targetLinkId,
    observation: null, domainHealth: items.flatMap(item => item.health
      ? [{ domainId: item.domain.id, domainRevision: item.domain.revision, facts: item.health, observations: [] }] : []) }));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  homes.answer(serverId, `POST ${path}/execution-authorization`, { select: body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
    return { body: { v: 1, token: 'domain-health-proof', binding: {
      serverIdentityId: account.serverIdentityId, accountId,
      authentication: { kind: 'account', tokenEpoch: 0 }, actionId, requestId: envelope.requestId,
      target: { kind: 'machine', machineId: input.machineId }, machineId: input.machineId, installationId: 'installation-a',
      custodianAccountId: accountId, accountEncryptionMode: 'plain',
      deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } } };
  } });
  homes.answer(serverId, `POST ${path}`, { select: body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
    const continuation = envelope.resourceContinuation;
    if (continuation?.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) throw new Error('Expected a Domain health Resource read');
    return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true,
      result: { ok: true, resource: continuation.params.resource, contentType: 'application/json',
        bytesBase64: bytes.toString('base64'), digest } } } };
  } });
  return { actionId, digest: () => digest };
}

function createController() {
  return createDeploymentReadControllerV1({ scope, transport: createDeploymentReadTransport(account.accountLifetime) });
}

async function renderDomains(
  detail: Detail,
  items: readonly DeploymentDomainReadItemV1[],
  boundary: DomainBoundary,
  healthSetup = false,
  receipt = createDeploymentReceiptDetailV1(),
  phone = false,
  review: React.ComponentProps<typeof DeploymentEnvironmentDetail>['review'] = noReview,
) {
  const { serverId, accountId } = scope;
  const environment = { ...detail.environment, serverId };
  homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: {
    ok: true, environment, targetLinks: detail.targetLinks.map(row => row.targetLink), secretScope: detail.secretScope,
  } });
  await seedArtifact(environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, 'Staging', detail.content);
  for (const { targetLink, content } of detail.targetLinks) {
    if (content) await seedArtifact(targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, 'Runtime target', content);
  }
  await seedDomains(environment.id, items);
  homes.answer(serverId, `GET /v1/deployments/receipts/${receipt.deployment.id}`, {
    body: { ok: true, deployment: receipt.deployment },
  });
  await seedArtifact(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Serving deployment', receipt.content);
  const controller = createController();
  const actions = await connectDomainActions(environment, boundary);
  const screen = await renderScreen(
    <PresentedDetailNavigationProvider>
      <DeploymentEnvironmentDetail
        controller={controller}
        environmentId={detail.environment.id}
        demand={shown}
        accountId={accountId}
        serverId={serverId}
        phone={phone}
        deploy={null}
        review={review}
        onOpenReceipt={() => {}}
        destination={{ tab: 'domains', section: null }}
        domainActions={actions}
        lifetime={healthSetup ? account.accountLifetime : undefined}
      />
    </PresentedDetailNavigationProvider>,
  );
  const settle = async (testID: string) => {
    await act(async () => {
      await Promise.race([
        waitForTestEvent(
          screen.subscribe,
          () => screen.findByTestId(testID),
          (node) => node !== null,
        ),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    });
    return screen.findByTestId(testID);
  };
  return { screen, controller, settle };
}

it('offers the shared investigation beside a failed Domain only; one that needs a look says so and stays quiet (G5)', async () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const healthy = domain('healthy-domain', 'healthy.example.test');
  const warning = domain('attention-domain', 'attention.example.test');
  const failing = domain('failed-domain', 'failed.example.test');
  const attention = { ...warning, domain: { ...warning.domain, state: 'warning' as const } };
  const failed = { ...failing, domain: { ...failing.domain, state: 'failed' as const } };
  const { screen, controller, settle } = await renderDomains(detail, [healthy, attention, failed], domainActions(detail));
  try {
    await settle('project-deployments.environment.domains.failed-domain');
    expect(screen.findByTestId('project-deployments.environment.domains.failed-domain.investigate')).not.toBeNull();
    expect(screen.findByTestId('project-deployments.environment.domains.attention-domain.investigate')).toBeNull();
    expect(screen.findByTestId('project-deployments.environment.domains.healthy-domain.investigate')).toBeNull();
  } finally { await screen.unmount(); controller.retire(); }
});

type ActionBoundary = (input: unknown) => unknown;
type DomainBoundary = {
  addDomain: ActionBoundary;
  setBindings?: ActionBoundary;
  previewDomainDns?: ActionBoundary;
  createDomainDns?: ActionBoundary;
  inspectPlatformTarget?: DomainIngressInspection;
  offerDomainAddress?: ActionBoundary;
};

// The published Account plugin is the provider boundary. Its declarations,
// admission, schema checks, cancellation and error presentation stay real.
async function installCloudflareInspection(inspect: DomainIngressInspection) {
  if (installedCloudflare) await installedCloudflare.dispose();
  const [{ manifest }, { installPortableAccountPluginReleaseForTest }, desktopFetch] = await Promise.all([
    import('../../../../../../packages/plugins/deploy-cloudflare/src/manifest'),
    import('@/dev/testkit/harness/portableAccountPlugin'),
    import('@/utils/platform/tauri/transferFetch'),
  ]);
  // Desktop places the Account Action locally. Home HTTP still uses its ordinary fixture.
  if (!restoreDesktopFetch) {
    const transport = vi.spyOn(desktopFetch, 'resolveTauriRuntimeFetch').mockResolvedValue(homes.request);
    restoreDesktopFetch = () => transport.mockRestore();
  }
  const declarations = manifest.contributes.actions.filter(action =>
    action.id === 'workers-domain-zones-read' || action.id === 'cloudflare-named/selections-read');
  const connectedAccountDescriptors = manifest.contributes.connectedAccountDescriptors.map(descriptor => {
    const { account: _accountRuntime, ...authentication } = descriptor.authentication;
    return { ...descriptor, authentication };
  });
  const resources = manifest.contributes.resources.filter(resource => resource.kind === 'asset');
  installedCloudflare = await installPortableAccountPluginReleaseForTest({
    manifest: { ...manifest, contributes: PluginContributesV2Schema.parse({
      actions: declarations, connectedAccountDescriptors, resources,
    }) },
    accountLifetime: account.accountLifetime,
    publishProjection: true,
    activate(api) {
      for (const { id: localId } of declarations) {
        api.actions.register(localId, async (input, { signal, requestId }) => {
          if (!isJsonObject(input)) throw new Error('Expected Cloudflare input');
          const result = await inspect(formatQualifiedPluginActionId({ pluginId: manifest.id, localId }), input, { signal, actionRequestId: requestId });
          if (!result.ok) {
            throw new PluginError({ code: result.code, details: StrictJsonValueSchema.parse(result.details) });
          }
          return StrictJsonValueSchema.parse({
            defaults: { connector: { imageRef: 'cloudflare/cloudflared', version: '2026.10.0' } },
            connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' },
            ...(result.value as Record<string, unknown>),
          });
        });
      }
    },
  });
}

function domainActions(detail: Detail) {
  return {
    addDomain: vi.fn(async (raw: unknown) => {
      const input = DeploymentActionInputSchemasV1['deployments.domains.add'].parse(raw);
      return { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
        domain: domain(input.domainId, 'docs.happier.dev').domain };
    }),
    setBindings: vi.fn(async (_raw: unknown) => ({
      ok: true as const,
      environmentId: detail.environment.id,
      revision: detail.environment.revision + 1,
    })),
  } satisfies DomainBoundary;
}

async function connectDomainActions(environment: Detail['environment'], boundary: DomainBoundary): Promise<DeploymentDomainEditing['actions']> {
  const { serverId } = scope;
  const { addDomain, setBindings, previewDomainDns, createDomainDns, inspectPlatformTarget, offerDomainAddress } = boundary;
  const common = { machineId: environment.controllerMachineId, installationId: 'installation-a', tokenEpoch: 0 };
  await answerExternalActionAccountForHome(homes, serverId, { ...common, actionId: 'deployments.domains.add',
    execute: input => addDomain(input),
    failure: result => {
      if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== false
        || !('error' in result) || typeof result.error !== 'string') return null;
      return { errorCode: result.error, error: result.error,
        ...('details' in result ? { details: result.details } : {}),
        ...('failureCause' in result ? { failureCause: result.failureCause } : {}) };
    },
  });
  if (setBindings) await answerExternalActionAccountForHome(homes, serverId, {
    ...common, actionId: 'deployments.bindings.set', execute: input => setBindings(input),
  });
  if (previewDomainDns) await answerExternalActionAccountForHome(homes, serverId, {
    ...common, actionId: 'deployments.domains.verify', execute: input => previewDomainDns(input),
  });
  if (offerDomainAddress) await answerExternalActionAccountForHome(homes, serverId, {
    ...common, actionId: 'deployments.domains.verify', execute: async input => ({
      ok: true, environmentId: environment.id, addressOffer: await offerDomainAddress(input),
    }),
  });
  if (createDomainDns) await answerExternalActionAccountForHome(homes, serverId, {
    ...common, actionId: DEPLOYMENT_DOMAIN_DNS_CREATE_ACTION_ID_V1, execute: input => createDomainDns(input),
  });
  if (inspectPlatformTarget) await installCloudflareInspection(inspectPlatformTarget);
  const actions = createDeploymentActions(account.accountLifetime, environment.projectSourceId);
  return {
    addDomain: actions.addDomain, removeDomain: actions.removeDomain, verifyDomain: actions.verifyDomain,
    ...(setBindings ? { setBindings: actions.setBindings } : {}),
    ...(previewDomainDns ? { previewDomainDns: actions.previewDomainDns } : {}),
    ...(offerDomainAddress ? { offerDomainAddress: actions.offerDomainAddress } : {}),
    ...(createDomainDns ? { createDomainDns: actions.createDomainDns } : {}),
    ...(inspectPlatformTarget ? { inspectPlatformTarget: actions.inspectPlatformTarget } : {}),
  };
}

it.each([false, true])('keeps retained Domains visible as unattached after runtime replacement or removal (no current link: %s)', async noCurrentLink => {
  const base = createDeploymentEnvironmentDetailV1();
  const detail = { ...base, environment: { ...base.environment,
    runtimeTargetLinkId: noCurrentLink ? undefined : base.environment.runtimeTargetLinkId } };
  const known = domain('current-domain', 'current.example.test');
  const current = { ...known, domain: { ...known.domain, targetLinkId: base.environment.runtimeTargetLinkId! } };
  const predecessor = { ...domain('predecessor-domain', 'old.example.test'),
    domain: { ...known.domain, id: 'predecessor-domain', contentArtifactId: 'content-predecessor-domain', targetLinkId: 'previous-target-link' } };
  const { screen, controller, settle } = await renderDomains(detail, [predecessor, current], domainActions(detail));
  try {
    await settle('project-deployments.environment.domains.current-domain');
    const { Status } = await import('@happier-dev/plugin-ui');
    const state = (domainId: string) => screen.findAllByType(Status)
      .find(node => node.props.testID === `project-deployments.environment.domains.${domainId}.state`)?.props.label;
    expect(state('predecessor-domain')).toBe('Unattached');
    expect(state('current-domain')).toBe(noCurrentLink ? 'Unattached' : 'Serving');
    expect(screen.getTextContent()).toContain('old.example.test');
  } finally { await screen.unmount(); controller.retire(); }
});

it('keeps a failed retained Domain recovery available', async () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const known = domain('failed-retained', 'old.example.test');
  const failed = { ...known, domain: { ...known.domain, targetLinkId: 'previous-target-link', state: 'failed' as const } };
  const { screen, controller, settle } = await renderDomains(detail, [failed], domainActions(detail));
  try {
    await settle('project-deployments.environment.domains.failed-retained');
    const { Status } = await import('@happier-dev/plugin-ui');
    const { t } = await import('@/text');
    expect.soft(screen.findAllByType(Status).find(node =>
      node.props.testID === 'project-deployments.environment.domains.failed-retained.state')?.props.label)
      .toBe(t('projects.deployments.domainStateFailed'));
    expect.soft(screen.findByTestId('project-deployments.environment.domains.failed-retained.checkAgain')).not.toBeNull();
  } finally { await screen.unmount(); controller.retire(); }
});

function platformDetail(targetKind = 'vercel', content: Detail['targetLinks'][number]['content'] = {}) {
  return createDeploymentEnvironmentDetailV1({ targetLinks: [{ content,
    targetLink: createDeploymentTargetLinkHeaderV1({ source: { kind: 'plugin',
      contribution: { pluginId: `happier.deploy.${targetKind === 'workers' ? 'cloudflare' : 'vercel'}`, localId: 'runtime' } },
      targetKind, machines: [], members: [], machineId: 'machine-a', installationId: 'installation-a' }),
  }] });
}

describe('Environment → Domains: add form (P6)', () => {
  it('names where the recorded routed replicas run, inside the row and without raw ids (DEPLOY-ACCEPT-143 A3)', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const known = domain('recorded', 'shop.example.com');
    const item = { ...known, domain: { ...known.domain, routedReplicas: {
      source: 'recordedTopology' as const, count: 2, replicas: [
        { machineId: 'machine-a', installationId: 'installation-a', containerName: 'shop-web-1' },
        { machineId: 'machine-b', installationId: 'installation-b', containerName: 'shop-web-2' },
      ],
    } } };
    const { screen, controller, settle } = await renderDomains(detail, [item, domain('unknown', 'old.example.com')], domainActions(detail));
    try {
      await settle('project-deployments.environment.domains.recorded');
      const text = screen.getTextContent();
      // Machine and container ids stay out of the page.
      expect(text).not.toContain('shop-web-1');
      expect(text).not.toContain('machine-a ·');
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('opens the exact saved Domain check setup before enrolling a cadence', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const actions = domainActions(detail);
    const item = domain('public-domain', 'shop.example.com');
    const { screen, controller, settle } = await renderDomains(detail, [item], actions, true);
    await settle('project-deployments.environment.domains.public-domain');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const menu = screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel === 'shop.example.com');
    expect(menu).toBeDefined();
    expect(menu!.props.items).toContainEqual(expect.objectContaining({ id: 'configure-checks' }));
    await act(async () => { menu!.props.onSelect('configure-checks'); });
    // The one Add check surface (R10-D1) opens the check's own form, not the workflow trigger editor.
    const { AddCheckSetup } = await import('./AddCheckSetup');
    const setup = screen.findAllByType(AddCheckSetup)[0]!;
    expect(setup.props.seed).toMatchObject({ sourceInstanceId: expect.stringMatching(/^health:/),
      setupInput: { v: 1, subject: { kind: 'environment', environmentId: detail.environment.id },
        domain: { domainId: 'public-domain', targetLinkId: 'target-link' } } });
    expect(setup.props.seed?.setupInput).not.toHaveProperty('checks');
    expect(actions.addDomain).not.toHaveBeenCalled();
    await screen.unmount(); controller.retire();
  });
  it('adds a platform address with provider routing and no native service or port', async () => {
    const detail = platformDetail();
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findByTestId(`${id}.service`)).toBeNull();
      expect(screen.findByTestId(`${id}.port`)).toBeNull();
      await act(async () => { screen.changeTextByTestId(`${id}.host`, 'app.example.test'); });
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: { hostname: 'app.example.test', target: { kind: 'provider' } },
      })));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('uses the linked Workers credential and waits for an explicit zone choice before adding', async () => {
    const account = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'linked' };
    const detail = platformDetail('workers', { credentialPrincipal: { kind: 'account', accountId: 'account-owner',
      purpose: { consumer: { pluginId: 'happier.deploy.cloudflare', localId: 'workers-inspect' }, purpose: 'deploy.manage' },
      target: { kind: 'account', account } }, providerIdentity: { providerAccountId: 'cloudflare-account',
        providerResourceId: 'worker-exact', providerEnvironment: 'production' }, providerEnvironment: { kind: 'native', selection: { kind: 'script', scriptName: 'worker-exact' } } });
    const inspectPlatformTarget = vi.fn<DomainIngressInspection>(async () => ({ ok: true, value: { kind: 'ready',
      zones: [{ zoneId: 'zone-other', name: 'other.test' }, { zoneId: 'zone-exact', name: 'example.test' }], options: [],
      defaults: { connector: { imageRef: 'unused', version: 'unused' } }, connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } } }));
    const actions = { ...domainActions(detail), inspectPlatformTarget };
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => { screen.changeTextByTestId(`${id}.host`, 'app.example.test'); });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain).not.toHaveBeenCalled();
      expect(screen.findByTestId(`${id}.ingress.account`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
      await vi.waitFor(() => expect(inspectPlatformTarget).toHaveBeenCalledExactlyOnceWith('happier.deploy.cloudflare/actions/workers-domain-zones-read',
        { credentialRef: account, accountId: 'cloudflare-account', hostname: 'app.example.test' }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const choice = await vi.waitFor(() => {
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${id}.ingress.zone`);
        expect(menu).toBeDefined();
        return menu;
      });
      await act(async () => { choice!.props.onSelect('zone-exact'); });
      expect(screen.findByTestId(`${id}.ingress.read`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: {
        hostname: 'app.example.test', target: { kind: 'provider', zone: { zoneId: 'zone-exact', name: 'example.test' } },
      } })));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('renders the retained provider DNS instructions after a fresh Domain read', async () => {
    const detail = platformDetail();
    const item = domain('provider-domain', 'app.example.test', { target: { kind: 'provider' }, healthCheck: undefined,
      providerObservation: { v: 1, hostname: 'app.example.test', state: 'pending',
        dns: [{ type: 'TXT', name: '_validation.app.example.test', value: 'retained-provider-value' }] } });
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      expect(await settle('project-deployments.environment.domains.provider-domain')).not.toBeNull();
      const { Text } = await import('@/components/ui/text/Text');
      // The record to add is the row's selectable second line ("Add TXT … → value").
      expect(screen.findAllByType(Text).some(node => node.props.selectable === true
        && String(node.props.children).includes('TXT _validation.app.example.test → retained-provider-value'))).toBe(true);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('says why a provider could not set an address up, through the failure details presenter', async () => {
    const detail = platformDetail();
    const item = domain('provider-failed', 'app.example.test', { target: { kind: 'provider' }, healthCheck: undefined,
      providerObservation: { v: 1, hostname: 'app.example.test', state: 'pending', dns: [],
        failureCause: { phase: 'deployment.domain.provider', errorClass: 'ProviderError', errorCode: 'domain_taken', httpStatus: 409 } } });
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      await settle('project-deployments.environment.domains.provider-failed');
      expect(screen.findByTestId('approvals.technical-details')).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('opens the Cloudflare record picker beside pending provider records, and only where the page can write it', async () => {
    const detail = platformDetail();
    const pending = domain('provider-domain', 'app.example.test', { target: { kind: 'provider' }, healthCheck: undefined,
      providerObservation: { v: 1, hostname: 'app.example.test', state: 'pending',
        dns: [{ type: 'CNAME', name: 'app.example.test', value: 'cname.vercel-dns.com' }] } });
    const plain = domain('plain', 'shop.example.com');
    const rowId = 'project-deployments.environment.domains';
    const writable = { ...domainActions(detail), createDomainDns: vi.fn(), inspectPlatformTarget: vi.fn<DomainIngressInspection>() };
    for (const [actions, offered] of [[writable, true], [domainActions(detail), false]] as const) {
      const { screen, controller, settle } = await renderDomains(detail, [pending, plain], actions);
      try {
        await settle(`${rowId}.provider-domain`);
        expect(screen.findByTestId(`${rowId}.plain.dnsProvider`)).toBeNull();
        expect(screen.findByTestId(`${rowId}.provider-domain.dnsProvider`) !== null).toBe(offered);
        if (offered) {
          await screen.pressByTestIdAsync(`${rowId}.provider-domain.dnsProvider`);
          expect(await settle(`${rowId}.dns.form`)).not.toBeNull();
          // The provider-owned zone picker; nothing is written before its own review.
          expect(screen.findByTestId(`${rowId}.add.ingress.zones.read`)).not.toBeNull();
          expect(writable.createDomainDns).not.toHaveBeenCalled();
        }
      } finally { await screen.unmount(); controller.retire(); }
    }
  });

  it.each(['docs.happier.dev', '*.happier.dev'])('adds redirect, certificate and basic-auth references for %s in one Domain Add', async hostname => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = {
      ...base,
      content: { ...base.content, ingress: undefined },
    };
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(
      detail,
      [],
      actions,
    );
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, hostname);
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      // Redirect, certificate and basic auth wait under More options (TUNNEL-LIVE-1119 friction list).
      await screen.pressByTestIdAsync(`${id}.advanced.header`);
      await act(async () => {
        screen.changeTextByTestId(`${id}.redirect`, 'www.happier.dev');
        screen.changeTextByTestId(`${id}.basicAuth`, 'preview');
      });
      await screen.pressByTestIdAsync(`${id}.certificate:custom`);
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: {
            hostname,
            target: {
              service: 'web',
              containerPort: 3000,
              redirectTo: 'www.happier.dev',
            },
            tls: { kind: 'custom' },
            basicAuth: { username: 'preview' },
          },
        }),
      ));
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('adds without a check (the Domain owner defaults it) and keeps an authored path from Advanced', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      expect(screen.findByTestId(`${id}.needs`), 'no check field is required').toBeNull();
      await screen.pressByTestIdAsync(`${id}.advanced.header`);
      await act(async () => screen.changeTextByTestId(`${id}.checkStatus`, 'abc'));
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(actions.addDomain, 'a status that is not a number cannot be added').not.toHaveBeenCalled();
      await act(async () => {
        screen.changeTextByTestId(`${id}.check`, '/ready');
        screen.changeTextByTestId(`${id}.checkStatus`, '');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: expect.objectContaining({ healthCheck: { path: '/ready' } }),
      })));
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('shows Docker Desktop Domain unavailability from the serving generation before Add', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const receipt = createDeploymentReceiptDetailV1();
    detail.targetLinks[0]!.targetLink.activeDeploymentId = receipt.deployment.id;
    const projection = { machineId: 'machine-a', installationId: 'installation-a', platform: 'linux/amd64',
      manifestFingerprint: 'manifest-a', configInputDigests: [], physicalProjectName: 'shop',
      toolVersion: '2.0', services: ['app'], profiles: [], engineKind: 'dockerDesktop' as const };
    receipt.content.ownServer = { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({
      v: 1, environmentId: detail.environment.id, environmentRevision: detail.environment.revision,
      targetLinkId: detail.targetLinks[0]!.targetLink.id, targetLinkRevision: detail.targetLinks[0]!.targetLink.revision,
      sourceIntent: receipt.content.sourceIntent, manifestFingerprint: projection.manifestFingerprint,
      configInputDigests: projection.configInputDigests, physicalProjectName: projection.physicalProjectName,
      toolVersion: projection.toolVersion, services: projection.services, profiles: projection.profiles, members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
      bindings: [], images: receipt.content.images, runtimeProjections: [projection],
    }) };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail), false, receipt);
    try {
      expect(await settle('project-deployments.environment.domains.unavailableDockerDesktop')).not.toBeNull();
      expect(screen.findByTestId(id)).toBeNull();
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('keeps basic auth and your certificate off where the page cannot bind their credentials', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = {
      ...base,
      content: { ...base.content, ingress: undefined },
    };
    const { setBindings: _unused, ...withoutBindings } = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(
      detail,
      [],
      withoutBindings,
    );
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      // The simple link flow is address, where it reaches and the app; the rest waits under More options.
      expect(screen.findByTestId(`${id}.redirect`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.advanced.header`);
      expect(screen.findByTestId(`${id}.redirect`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.basicAuth`)).toBeNull();
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it("picks Service from the definition and Port from that service's declared export", async () => {
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = createDeploymentEnvironmentDetailV1();
    const definition = {
      kind: 'repository' as const,
      ref: 'main',
      compose: {
        path: 'compose.yaml',
        profiles: [],
        services: ['web', 'worker'],
        primaryService: 'web',
      },
    };
    const detail = {
      ...base,
      content: {
        ...base.content,
        ingress: undefined,
        definition,
        ownServer: {
          rollout: 'recreate' as const,
          autoRestorePreviousRelease: false,
          serviceExports: [
            {
              key: 'http',
              service: 'web',
              containerPort: 8080,
              scheme: 'http',
              exposure: 'public' as const,
            },
          ],
        },
      },
    };
    const actions = domainActions(detail);
    const { screen, controller, settle } = await renderDomains(
      detail,
      [],
      actions,
    );
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () =>
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev'),
      );
      const select = (testID: string) =>
        screen
          .findAllByType(DropdownMenu)
          .find((node) => node.props.testID === testID);
      expect(
        select(`${id}.service`)?.props.items.map(
          (item: { id: string }) => item.id,
        ),
      ).toEqual(['web', 'worker']);
      await act(async () => {
        select(`${id}.service`)!.props.onSelect('web');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: expect.objectContaining({
            target: { service: 'web', containerPort: 8080 },
          }),
        }),
      ));
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Environment → Domains: Service defaults for saved Compose and apps (PAGE-ACCEPT-100 D7, R2-D16)', () => {
  const withDatabase = (definition: Detail['content']['definition']) => {
    const base = createDeploymentEnvironmentDetailV1();
    // A real default PostgreSQL template's provenance: the database is the template's data service.
    const template = { templateRef: { sourceId: 'store', itemId: 'postgres', version: '17.0.0',
      ref: { kind: 'content' as const, digest: `sha256:${'c'.repeat(64)}` } }, services: ['database'],
      definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
      data: [{ service: 'database', engine: 'postgres' as const, port: 5432 }] };
    return { ...base, content: { ...base.content, ingress: undefined, definition, template } };
  };

  it('starts a typed Service on the app that runs when Compose\'s primary service is the database', async () => {
    const detail = withDatabase({ kind: 'repository', ref: 'main',
      compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'database' } });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      // The fixture's serving receipt runs `app`.
      expect(screen.findByTestId(`${id}.service`)?.props.value).toBe('app');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('starts Service on the only app the definition selects, and prefills its one port', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = withDatabase({ kind: 'repository', ref: 'main',
      compose: { path: 'compose.yaml', profiles: [], services: ['database', 'web'], primaryService: 'database' } });
    const detail = { ...base, content: { ...base.content, ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: false,
      serviceExports: [{ key: 'http', service: 'web', containerPort: 8080, scheme: 'http', exposure: 'public' as const }] } } };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      expect(select(`${id}.service`)?.props.selectedId).toBe('web');
      // One declared port is a prefilled, still editable field: a one-option menu offers no choice (DEPLOY-REACCEPT-1113 D6).
      expect(select(`${id}.port`)).toBeUndefined();
      expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('8080');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('offers a Port choice only when the service declares more than one port (DEPLOY-REACCEPT-1113 D6)', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { parse } = await import('yaml');
    const document = 'services:\n  app:\n    image: nginx:alpine\n    expose:\n      - "80"\n      - "443"\n';
    const countParses = () => vi.mocked(parse).mock.calls.filter(([source]) => source === document).length;
    const beforeOpen = countParses();
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document, profiles: [], services: ['app'], primaryService: 'app' });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await act(async () => {});
      expect(countParses(), 'Compose parses before Add').toBe(beforeOpen);
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(select(`${id}.port`)?.props.items.map((item: { id: string }) => item.id)).toEqual(['80', '443']);
      });
      expect(countParses()).toBe(beforeOpen + 1);
      // Nothing is chosen yet, so the field shows the choose placeholder, never the first port as if picked (D9).
      const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
      const port = screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${id}.port`);
      expect(port?.props.selectedId).toBeNull();
      expect(port?.props.placeholder).toBe(t('common.choose'));
      await act(async () => { select(`${id}.port`)!.props.onSelect('443'); });
      expect(screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${id}.port`)?.props.selectedId).toBe('443');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('offers the stored Compose services as Service choices before the first deploy (DEPLOY-REACCEPT-1113E P1)', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  app:\n    image: nginx:alpine\n    expose:\n      - "80"\n', profiles: [], services: [] });
    detail.targetLinks[0]!.targetLink.activeDeploymentId = undefined;
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(select(`${id}.service`)?.props.selectedId).toBe('app');
      });
      expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('80');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('prefills the Compose port when Add domain opens with the only service already selected', async () => {
    const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  database:\n    image: postgres:17\n    ports:\n      - target: 5432\n        host_ip: 127.0.0.1\n        protocol: tcp\n',
      profiles: [], services: ['database'], primaryService: 'database' });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${id}.service`)?.props.selectedId)
        .toBe('database');
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('5432');
      });
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('prefills the database container port from stored PostgreSQL Compose and never carries it to another service (R2-D16)', async () => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const detail = withDatabase({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  database:\n    image: postgres:17\n    ports:\n      - target: 5432\n        published: "15432"\n        host_ip: 127.0.0.1\n        protocol: tcp\n  worker:\n    image: alpine\n',
      profiles: [], services: ['database', 'worker'], primaryService: 'database' });
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const select = (testID: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === testID);
      expect(select(`${id}.service`)?.props.selectedId).toBe('worker');
      await act(async () => { select(`${id}.service`)!.props.onSelect('database'); });
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('5432');
      });
      expect(select(`${id}.port`)).toBeUndefined();
      expect(select(`${id}.service`)?.props.selectedId).toBe('database');
      await act(async () => { select(`${id}.service`)!.props.onSelect('worker'); });
      expect(screen.findByTestId(`${id}.port`)?.props.value).toBe('');
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: credentials an address needs', () => {
  it('says a basic-auth address needs its password and binds the chosen Saved Secret through deployments.bindings.set', async () => {
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    picked.ref = formatSharedSavedSecretRefV1('resource-password');
    const detail = createDeploymentEnvironmentDetailV1();
    const actions = domainActions(detail);
    const guarded = domain('guarded', 'preview.happier.dev', {
      basicAuth: { username: 'preview' },
    });
    const { screen, controller, settle } = await renderDomains(
      detail,
      [guarded],
      actions,
    );
    const menu = 'project-deployments.environment.domains.guarded.menu';
    try {
      expect(await settle(menu)).not.toBeNull();
      const dropdown = screen
        .findAllByType(DropdownMenu)
        .find(
          (node) =>
            node.props.testID === undefined &&
            node.props.popoverAccessibilityLabel === 'preview.happier.dev',
        )!;
      expect(
        dropdown.props.items.map((item: { id: string }) => item.id),
      ).toContain('credential:basicAuth');
      await act(async () => dropdown.props.onSelect('credential:basicAuth'));
      await vi.waitFor(() =>
        expect(actions.setBindings).toHaveBeenCalledTimes(1),
      );
      expect(actions.setBindings).toHaveBeenCalledWith({
        serverId: scope.serverId,
        environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision,
        remove: [],
        set: [
          {
            purpose: 'domainCredential',
            domainId: 'guarded',
            role: 'basicAuth',
            source: { kind: 'secret', ref: picked.ref, resourceRevision: 4 },
          },
        ],
      });
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });

  it('stays quiet once the password is bound', async () => {
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = {
      ...base,
      content: {
        ...base.content,
        bindings: [
          {
            purpose: 'domainCredential' as const,
            domainId: 'guarded',
            role: 'basicAuth' as const,
            source: {
              kind: 'secret' as const,
              ref: formatSharedSavedSecretRefV1('resource-password'),
              resourceRevision: 4,
            },
          },
        ],
      },
    };
    const guarded = domain('guarded', 'preview.happier.dev', {
      basicAuth: { username: 'preview' },
    });
    const { screen, controller, settle } = await renderDomains(
      detail,
      [guarded],
      domainActions(detail),
    );
    try {
      expect(
        await settle('project-deployments.environment.domains.guarded.menu'),
      ).not.toBeNull();
      const dropdown = screen
        .findAllByType(DropdownMenu)
        .find(
          (node) =>
            node.props.popoverAccessibilityLabel === 'preview.happier.dev',
        )!;
      expect(
        dropdown.props.items.map((item: { id: string }) => item.id),
      ).not.toContain('credential:basicAuth');
    } finally {
      await screen.unmount();
      controller.retire();
    }
  });
});

describe('Environment → Domains: add form reads as a place, once (PAGE-ACCEPT-85 D3)', () => {
  it('names where visitors reach it instead of the topology paragraph, and prefills Compose\'s primary service', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      expect(screen.findByTestId(`${id}.ingress.notRecorded`)).toBeNull();
      // Where visitors reach it is named as a place (a tile per choice), not the topology paragraph.
      expect(screen.findByTestId(`${id}.ingress.mode:environment`)).not.toBeNull();
      // The fixture's compose.yaml names `app` as its primary service.
      expect(screen.findByTestId(`${id}.service`)?.props.value).toBe('app');
      // An empty Domains list says so once: not again under the open form.
      expect(screen.findByTestId('project-deployments.environment.domains.empty')).toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: Find zones can be stopped (O-DEPLOY F2)', () => {
  function pendingInspect() {
    type Result = Awaited<ReturnType<DomainIngressInspection>>;
    const requests: ReturnType<typeof createDeferred<Result>>[] = [];
    const inspectPlatformTarget = vi.fn<DomainIngressInspection>(() => {
      const response = createDeferred<Result>();
      requests.push(response);
      return response.promise;
    });
    // An admitted Account read can finish after the form has stopped waiting.
    const finish = () => act(async () => {
      for (const response of requests) response.resolve({ ok: false, code: 'denied', details: {} });
      await Promise.all(requests.map(response => response.promise));
    });
    return { requests, finish, inspectPlatformTarget };
  }
  async function openAndFind(detail: Detail, inspectPlatformTarget: DomainIngressInspection) {
    const rendered = await renderDomains(detail, [], { ...domainActions(detail), inspectPlatformTarget });
    expect(await rendered.settle(id)).not.toBeNull();
    await rendered.screen.pressByTestIdAsync(id);
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    await act(async () => {
      rendered.screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
      rendered.screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account',
        account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } }, null);
    });
    await rendered.screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
    return rendered;
  }
  const tunnelDetail = () => {
    const base = createDeploymentEnvironmentDetailV1();
    return { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
  };

  it('Cancel stops waiting, ignores the late reply and offers Retry', async () => {
    const { requests, finish, inspectPlatformTarget } = pendingInspect();
    const { screen, controller } = await openAndFind(tunnelDetail(), inspectPlatformTarget);
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(screen.findByTestId(`${id}.ingress.zones.cancel`)).not.toBeNull();
      // One indicator while a read runs: the loading line with Cancel, not a disabled Find beside it (R7 nit).
      expect(screen.findByTestId(`${id}.ingress.zones.read`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.cancel`);
      await finish();
      expect(screen.findByTestId(`${id}.ingress.zones.stopped`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.ingress.zones.error`)).toBeNull();
      expect(screen.findByTestId(`${id}.ingress.zones.retry`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.retry`);
      await vi.waitFor(() => expect(inspectPlatformTarget).toHaveBeenCalledTimes(2));
    } finally { await finish(); await screen.unmount(); controller.retire(); }
  });

  it.each(['zones', 'tunnels'] as const)('clears the old %s error when Retry is cancelled and retains the form choice', async kind => {
    const { requests, finish, inspectPlatformTarget } = pendingInspect();
    const failure = { ok: false as const, code: 'denied',
      details: { requiredFact: 'cloudflarePermissions', remedy: 'Reconnect the selected Cloudflare account.' } };
    inspectPlatformTarget.mockResolvedValueOnce(kind === 'zones' ? failure : { ok: true,
      value: { kind: 'ready', zones: [{ zoneId: 'chosen-zone', name: 'happier.dev' }], options: [] } });
    // The same Find press reads the tunnels of the one zone found.
    if (kind === 'tunnels') inspectPlatformTarget.mockResolvedValueOnce(failure);
    const { screen, controller } = await openAndFind(tunnelDetail(), inspectPlatformTarget);
    try {
      await vi.waitFor(() => expect(screen.findByTestId(`${id}.ingress.${kind}.error`)).not.toBeNull());
      await screen.pressByTestIdAsync(`${id}.ingress.${kind}.retry`);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await screen.pressByTestIdAsync(`${id}.ingress.${kind}.cancel`);
      await finish();
      expect(screen.findByTestId(`${id}.ingress.${kind}.stopped`)).not.toBeNull();
      expect(screen.findByTestId(`${id}.ingress.${kind}.error`)).toBeNull();
      expect(screen.findByTestId(`${id}.host`)?.props.value).toBe('docs.happier.dev');
      if (kind === 'tunnels') expect(screen.findByTestId(`${id}.ingress.zone`)).not.toBeNull();
    } finally { await finish(); await screen.unmount(); controller.retire(); }
  });

  it('closing the form cancels a read still in flight', async () => {
    const { requests, finish, inspectPlatformTarget } = pendingInspect();
    const { screen, controller } = await openAndFind(tunnelDetail(), inspectPlatformTarget);
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await screen.pressByTestIdAsync(`${id}.cancel`);
      await finish();
      expect(screen.findByTestId(`${id}.host`)).toBeNull();
      expect(screen.findByTestId(`${id}.ingress.zones.error`)).toBeNull();
    } finally { await finish(); await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: a Find zones refusal names its own cause (PAGE-ACCEPT-88 N13)', () => {
  it.each(['provider-output', 'action-failure'] as const)('displays provider-authored recovery with Retry from %s', async source => {
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const reason = 'denied';
    const details = { requiredFact: 'cloudflarePermissions', remedy: 'Ask the Cloudflare account owner to restore zone access.' };
    const inspectPlatformTarget = vi.fn<DomainIngressInspection>(async () => source === 'provider-output'
      ? { ok: true as const, value: { kind: 'unavailable', options: [], reason, ...details } }
      : { ok: false as const, code: reason, details });
    const { screen, controller, settle } = await renderDomains(detail, [], { ...domainActions(detail), inspectPlatformTarget });
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
        screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account',
          account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } }, null);
      });
      await screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
      await vi.waitFor(() => expect(screen.findByTestId(`${id}.ingress.zones.error`)).not.toBeNull());
      const card = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === `${id}.ingress.zones.error`);
      expect(card?.props.diagnosticCode).toBe(reason);
      if (source === 'action-failure') {
        const requestId = inspectPlatformTarget.mock.calls[0]?.[2]?.actionRequestId;
        expect(requestId).toEqual(expect.any(String));
        expect(card?.props.diagnosticDetail).toContain(requestId);
      }
      expect(card?.props.title).toBe(details.remedy);
      expect(screen.findByTestId(`${id}.ingress.zones.retry`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.ingress.zones.retry`);
      await vi.waitFor(() => expect(inspectPlatformTarget).toHaveBeenCalledTimes(2));
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: Find zones says what it needs (JOURNEY-OPUS-88 F2)', () => {
  it('names the missing domain under a disabled Find zones instead of a lone greyed button', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const inspectPlatformTarget = vi.fn();
    const { screen, controller, settle } = await renderDomains(detail, [], { ...domainActions(detail), inspectPlatformTarget });
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
      await act(async () => {
        screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account',
          account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } }, null);
      });
      // The account is chosen but the Domain is empty: no read is running, so there is no Cancel; the row says why.
      expect(screen.findByTestId(`${id}.ingress.zones.cancel`)).toBeNull();
      expect(screen.findByTestId(`${id}.ingress.zones.needs`)).not.toBeNull();
      await act(async () => screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev'));
      expect(screen.findByTestId(`${id}.ingress.zones.needs`)).toBeNull();
      expect(inspectPlatformTarget).not.toHaveBeenCalled();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: Add domain never looks dead (UI-DOMAIN-VIEWER-1113)', () => {
  it('shows a refused add at the form the person pressed, not above it out of view', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const actions = { ...domainActions(detail), addDomain: vi.fn(async () => ({ ok: false as const, error: 'deployment_target_not_running' })) };
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledOnce());
      const atForm = await settle(`${id}.outcome`);
      expect(atForm, 'the refusal renders inside the open form, beside Add domain').not.toBeNull();
      const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
      const banner = screen.findAllByType(AttentionBanner)
        .find(node => String(node.props.testID).startsWith('project-deployments.outcome.refused'));
      // An add that failed says so (DEPLOY-ACCEPT-143 B1), and sits in the form's own gutter like the fields (B2).
      expect(banner?.props.title).toBe(t('projects.deployments.editors.domainAddFailedTitle'));
      expect(banner?.props.placement).toBe('inline');
      expect(screen.findByTestId(`${id}.host`), 'the form stays open with what was typed').not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('says a refused add needs a deploy without a second, different recovery button (DEPLOY-REACCEPT-1113 D7)', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    // An older daemon still authors its own sentence beside the fact; the recovery owner's one remedy wins.
    const actions = { ...domainActions(detail), addDomain: vi.fn(async () => ({ ok: false as const, error: 'required_fact_unavailable',
      details: { requiredFact: 'activeDomainMembers', step: 'native_execution',
        remedy: 'Deploy the app so it is running on this Machine, then add the domain' } })) };
    const openRecovery = vi.fn();
    const { screen, controller, settle } = await renderDomains(detail, [], actions, false, undefined, false, { ...noReview, openRecovery });
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(await settle(`${id}.outcome`)).not.toBeNull();
      const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
      const banner = screen.findAllByType(AttentionBanner)
        .find(node => String(node.props.testID).startsWith('project-deployments.outcome.refused'));
      const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
      // The cure is the Environment's own Deploy, already on the page: the sentence names it and no other route is offered.
      expect(banner?.props.description).toBe(readDeploymentRefusalRecoveryV1('required_fact_unavailable', { requiredFact: 'activeDomainMembers' })?.remedy);
      expect(banner?.props.action).toBeUndefined();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it.each([
    { code: 'machine_admin_access_required', cause: 'mode_none', reason: /administrator access is off for Fleet Edge/i },
    { code: 'machine_admin_access_required', cause: 'not_preauthorized', reason: /policy allows.+Fleet Edge.+without a password/i },
    { code: 'admin_access_unavailable', cause: undefined, reason: /needs administrator access on Machine Fleet Edge/i },
  ] as const)(
    'names the serving Machine and opens its administrator setup when Domain Add returns $code / $cause', async ({ code, cause, reason }) => {
    const { createMachineFixture, createMachineMetadataFixture } = await import('@/dev/testkit');
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ profileScope: { serverId: scope.serverId, accountId: scope.accountId } });
    storage.getState().applyMachines([
      createMachineFixture({ id: 'controller-machine', metadata: createMachineMetadataFixture({ host: 'Controller' }) }),
      createMachineFixture({ id: 'origin-machine', metadata: createMachineMetadataFixture({ host: 'Fleet Edge' }) }),
    ], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const detail = createDeploymentEnvironmentDetailV1();
    const actions = { ...domainActions(detail), addDomain: vi.fn(async () => ({
      ok: false as const, error: code,
      ...(cause ? { failureCause: {
        phase: 'deployment.domain.native_execution', errorClass: 'Error', errorCode: cause, httpStatus: null,
      } } : {}),
      details: {
        step: 'native_execution', machineId: 'origin-machine',
        operation: { serverId: scope.serverId, machineId: 'controller-machine', operationId: 'domain-operation' },
        ...(code === 'admin_access_unavailable' ? {
          remedy: 'The machine needs administrator access for this change. Review its administrator connection before retrying.',
        } : {}),
      },
    })) };
    const openRecovery = vi.fn();
    const { screen, controller, settle } = await renderDomains(detail, [], actions, false, undefined, false, { ...noReview, openRecovery });
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      await screen.pressByTestIdAsync(`${id}.save`);
      expect(await settle(`${id}.outcome`)).not.toBeNull();
      const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
      const banner = screen.findAllByType(AttentionBanner)
        .find(node => String(node.props.testID).startsWith('project-deployments.outcome.refused'));
      await act(async () => { banner?.props.action?.onPress(); });
      expect(openRecovery).toHaveBeenCalledExactlyOnceWith('machineAdminAccess', { machineId: 'origin-machine' });
      expect(banner?.props.description).toMatch(reason);
      expect(banner?.props.description).not.toMatch(/origin-machine|controller-machine|Controller/);
      if (cause) expect(banner?.props.details).toEqual(expect.arrayContaining([expect.stringContaining(cause)]));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('names the field a disabled Add domain still needs', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const { screen, controller, settle } = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      expect(screen.findByTestId(`${id}.needs`), 'nothing left to name once Add domain can work').toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: whether the address reaches this Machine (#2)', () => {
  const dnsHealth = (status: 'up' | 'down' | 'unknown', reason: string) => ({ status,
    cause: { kind: 'dns' as const, reason, observerMachineId: 'controller', vantage: 'sameMachine' as const },
    evidence: { v: 1 as const,
    items: [{ source: { kind: 'alert' as const, label: 'DNS' }, author: { kind: 'process' as const },
      text: 'DNS finite observation' }] } });

  it('reviews a generated public address and submits its hostname through ordinary Domain Add', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const hostname = 'test.93-184-216-34.sslip.io';
    const offerDomainAddress = vi.fn().mockResolvedValue({ status: 'available', audience: 'public',
      lifetime: 'temporary', choices: [{ hostname, ingressIpv4: '93.184.216.34' }] });
    const actions = { ...domainActions(detail), offerDomainAddress };
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      await screen.pressByTestIdAsync(`${id}.offer`);
      expect(actions.addDomain).not.toHaveBeenCalled();
      expect(await settle(`${id}.offer.93.184.216.34`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.offer.93.184.216.34`);
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain.mock.calls[0]?.[0]).toMatchObject({ content: {
        hostname, addressKind: 'generatedCaddy', target: { service: 'web', containerPort: 3000 },
      } }));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('checks a complete draft only when asked, says what the native check found, and forgets it when the address changes', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    // The verify Action (preview mode) is the boundary: first no record, then the Machine's own challenge.
    const previewDomainDns = vi.fn()
      .mockResolvedValueOnce({ ok: true, environmentId: detail.environment.id, dnsHealth: dnsHealth('down', 'dns_missing') })
      .mockResolvedValueOnce({ ok: true, environmentId: detail.environment.id, dnsHealth: dnsHealth('up', 'dns_ready') });
    const actions = { ...domainActions(detail), previewDomainDns };
    const { screen, controller, settle } = await renderDomains(detail, [], actions);
    try {
      expect(await settle(id)).not.toBeNull();
      await screen.pressByTestIdAsync(id);
      await act(async () => {
        screen.changeTextByTestId(`${id}.host`, 'app.example.test');
        screen.changeTextByTestId(`${id}.service`, 'web');
        screen.changeTextByTestId(`${id}.port`, '3000');
      });
      // Typing asks nothing of the Machine.
      expect(previewDomainDns).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync(`${id}.dns.action`);
      await vi.waitFor(() => expect(previewDomainDns).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        environmentId: detail.environment.id, mode: 'preview', content: expect.objectContaining({ hostname: 'app.example.test' }),
      })));
      expect(await settle(`${id}.dns.missing`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.dns.action`);
      await vi.waitFor(() => expect(previewDomainDns).toHaveBeenCalledTimes(2));
      expect(await settle(`${id}.dns.ready`)).not.toBeNull();
      // A different address is a different question: the old answer is not shown for it.
      await act(async () => screen.changeTextByTestId(`${id}.host`, 'www.example.test'));
      expect(screen.findByTestId(`${id}.dns.ready`)).toBeNull();
      expect(screen.findByTestId(`${id}.dns.unchecked`)).not.toBeNull();
      await vi.waitFor(() => expect(previewDomainDns).toHaveBeenCalledTimes(2));
      // Advisory: Add domain does not wait on DNS.
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledOnce());
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('says on the row when the saved address does not reach this Machine yet', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const known = domain('elsewhere', 'shop.example.com');
    const item = { ...known, domain: { ...known.domain, dnsHealth: dnsHealth('down', 'dns_not_this_machine') } };
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      const row = await settle('project-deployments.environment.domains.elsewhere');
      expect(row).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.domains.elsewhere.checkAgain')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('Needs a look');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('shows a telemetry address without inventing a workload service route', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const known = domain('collector', 'collector.example.com');
    const item = { ...known, content: DeploymentDomainContentV1Schema.parse({ ...known.content, target: { kind: 'telemetry' } }) };
    const { screen, controller, settle } = await renderDomains(detail, [item], domainActions(detail));
    try {
      expect(await settle('project-deployments.environment.domains.collector')).not.toBeNull();
      expect(screen.getTextContent()).toContain('collector.example.com');
      expect(screen.getTextContent()).not.toContain('undefined:undefined');
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('draws each address with where it reaches, its certificate and its state (lab envDom)', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const expiresAt = Date.UTC(2027, 0, 8);
    const serving = { ...domain('serving', 'billing.example.com'), health: { availability: 'observed' as const, unavailableReason: null,
      observedAt: 1, vantage: 'outside' as const, certificate: { state: 'valid' as const, expiresAt }, needsYou: null } };
    const waiting = { ...domain('waiting', 'pay.example.com'), domain: { ...domain('waiting', 'pay.example.com').domain,
      dnsHealth: dnsHealth('down', 'dns_missing') } };
    const { installHostResourceWatchSocket } = await import('./resourceWatchSocket.testFixture');
    const socket = installHostResourceWatchSocket(answerDomainHealth(detail.environment, [serving, waiting]));
    const { screen, controller, settle } = await renderDomains(detail, [serving, waiting], domainActions(detail));
    try {
      await settle('project-deployments.environment.domains.waiting');
      await vi.waitFor(() => expect(screen.getTextContent()).toContain(
        `Automatic · expires ${new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`));
      const text = screen.getTextContent();
      expect(text).toContain('2 domains');
      expect(text).toContain('web:3000 /');
      expect(text).toContain(`Automatic · expires ${new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
      expect(screen.findByTestId('project-deployments.environment.domains.serving.state')).not.toBeNull();
      expect(text).toContain('Serving');
      // A waiting address says what it needs and carries the record to add, with Check again beside it.
      expect(text).toContain('No DNS record yet');
      expect(screen.findByTestId('project-deployments.environment.domains.waiting.line')).not.toBeNull();
      expect(text).toContain('Add an A or AAAA record');
      expect(screen.findByTestId('project-deployments.environment.domains.waiting.checkAgain')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.environment.domains.serving.checkAgain')).toBeNull();
    } finally { await screen.unmount(); controller.retire(); socket.mockRestore(); }
  });
});

describe('Environment → Domains: where an address leads (DEPLOY-REACCEPT-1113 D2)', () => {
  it('names replica Machines only when they are not just the Environment\'s own Machine', async () => {
    const { domainRouteMachineIds } = await import('./DeploymentDomainRow');
    const replica = (machineId: string) => ({ machineId, installationId: `i-${machineId}`, containerName: `c-${machineId}` });
    expect(domainRouteMachineIds([replica('own'), replica('own')], 'own')).toEqual([]);
    expect(domainRouteMachineIds([replica('other')], 'own')).toEqual(['other']);
    expect(domainRouteMachineIds([replica('own'), replica('other'), replica('other')], 'own')).toEqual(['own', 'other']);
    expect(domainRouteMachineIds(undefined, 'own')).toEqual([]);
    expect(domainRouteMachineIds([replica('own')], null)).toEqual(['own']);
  });
});

describe('Environment → Domains: the platform\'s built-in address', () => {
  // A Vercel or Workers Environment keeps its stable *.vercel.app / *.workers.dev address: it leads the list, read-only.
  async function renderPanel(items: readonly DeploymentDomainReadItemV1[], builtInUrls: readonly string[]) {
    const { DeploymentDomainsPanel } = await import('./DeploymentDomainsPanel');
    await seedDomains('environment-staging', items);
    const controller = createController();
    const screen = await renderScreen(
      <DeploymentDomainsPanel controller={controller} environmentId="environment-staging"
        environment={{ runtimeTargetLinkId: 'target-link' }} demand={shown} builtInUrls={builtInUrls} />,
    );
    return { screen, controller };
  }

  it('shows the managed row when the serving receipt also lists its provider-assigned address', async () => {
    const hostname = 'checkout-staging.up.railway.app';
    const assigned = domain('assigned', hostname, { target: { kind: 'provider' } });
    const item = { ...assigned, domain: { ...assigned.domain, provider: true } };
    const { screen, controller } = await renderPanel([item], [`https://${hostname}`]);
    try {
      const managed = 'project-deployments.environment.domains.assigned';
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(managed), node => node !== null); });
      expect(screen.findByTestId(managed)).not.toBeNull();
      expect(screen.findByTestId(`project-deployments.environment.domains.builtIn.${hostname}`)).toBeNull();
      const texts = screen.findAllByType('Text' as never).map(node => String(node.props.children));
      expect(texts).toContain(t('projects.deployments.editors.domainsCount', { count: 1 }));
    } finally { controller.retire(); }
  });

  it('lists the built-in address first and says what it is', async () => {
    const { screen, controller } = await renderPanel([domain('custom', 'shop.example.com')], ['https://acme-site.vercel.app']);
    try {
      const builtIn = 'project-deployments.environment.domains.builtIn.acme-site.vercel.app';
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId(builtIn), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      expect(screen.findByTestId(builtIn)).not.toBeNull();
      expect(screen.findByTestId(`${builtIn}.state`)).not.toBeNull();
      const texts = screen.findAllByType('Text' as never).map(node => String(node.props.children));
      expect(texts).toContain(t('projects.deployments.editors.domainBuiltIn'));
      // Rows in document order: the built-in address leads the Environment's own addresses.
      const custom = 'project-deployments.environment.domains.custom';
      const order = screen.findAll(node => typeof node.type === 'string'
        && (node.props.testID === builtIn || node.props.testID === custom)).map(node => node.props.testID);
      expect(order[0]).toBe(builtIn);
      expect(order).toContain(custom);
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('does not say there are no domains when only the built-in address exists', async () => {
    const { screen, controller } = await renderPanel([], ['https://edge-site.workers.dev']);
    try {
      const builtIn = 'project-deployments.environment.domains.builtIn.edge-site.workers.dev';
      await act(async () => {
        await Promise.race([
          waitForTestEvent(screen.subscribe, () => screen.findByTestId(builtIn), node => node !== null),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      });
      expect(screen.findByTestId(builtIn)).not.toBeNull();
      const texts = screen.findAllByType('Text' as never).map(node => String(node.props.children));
      expect(texts).not.toContain(t('projects.deployments.domainsEmpty'));
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: one Find, then a tunnel Happier can create (round 10, TUNNEL-LIVE-1119)', () => {
  const account = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' };
  const selection = (tunnel: Record<string, unknown>) => ({ provider: { kind: 'builtin' as const, id: 'cloudflareNamed' },
    config: { hostname: 'docs.happier.dev', controller: { accountId: 'acct', zoneId: 'zone-1',
      connector: { imageRef: 'cloudflare/cloudflared', version: '2026.10.0' }, tunnel, owned: [], dnsOwnership: [] } },
    credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount' as const, account } }] });
  const created = selection({ kind: 'create', name: 'docs.happier.dev' });
  const adopted = selection({ kind: 'adopt', tunnelId: 'tunnel-1', name: 'office' });
  async function findChoices(existing: readonly unknown[], previewDomainDns?: () => Promise<never>, automaticSelection = false,
    refusal?: { addDomain: () => Promise<unknown>; openRecovery: () => void }) {
    const inspectPlatformTarget = vi.fn<DomainIngressInspection>(async (_action, input) => (input as { zoneId?: string }).zoneId
      ? { ok: true, value: { kind: 'ready', options: existing, createOption: { label: 'docs.happier.dev', selection: created } } }
      : { ok: true, value: { kind: 'ready', zones: [{ zoneId: 'zone-1', name: 'happier.dev' }], options: [] } } as never);
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: { kind: 'cloudflareTunnel' as const } } };
    const actions = { ...domainActions(detail), inspectPlatformTarget, previewDomainDns,
      ...(refusal ? { addDomain: refusal.addDomain } : {}) };
    const rendered = await renderDomains(detail, [], actions, false, undefined, false,
      refusal ? { ...noReview, openRecovery: refusal.openRecovery } : noReview);
    expect(await rendered.settle(id)).not.toBeNull();
    await rendered.screen.pressByTestIdAsync(id);
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    await act(async () => {
      rendered.screen.changeTextByTestId(`${id}.host`, 'docs.happier.dev');
      rendered.screen.changeTextByTestId(`${id}.service`, 'web');
      rendered.screen.changeTextByTestId(`${id}.port`, '3000');
      const chooser = rendered.screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!;
      if (automaticSelection) {
        const callback = Reflect.get(chooser.props, 'onSelectSingleEligible');
        expect(callback).toBeTypeOf('function');
        callback({ kind: 'account', account }, null);
      } else {
        chooser.props.onChange({ kind: 'account', account }, null);
      }
    });
    if (automaticSelection) {
      expect(inspectPlatformTarget).not.toHaveBeenCalled();
      await act(async () => rendered.screen.findByTestId(`${id}.host`)!.props.onBlur());
    } else {
      await rendered.screen.pressByTestIdAsync(`${id}.ingress.zones.read`);
    }
    await vi.waitFor(() => expect(inspectPlatformTarget).toHaveBeenCalledTimes(2));
    expect(inspectPlatformTarget.mock.calls[1]![1]).toMatchObject({ zoneId: 'zone-1' });
    return { ...rendered, actions };
  }
  const tunnelSelect = async (screen: Awaited<ReturnType<typeof findChoices>>['screen']) => {
    const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
    return screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === `${id}.ingress.tunnel`);
  };

  it('preselects only the unique eligible target and finds zones once the hostname is entered', async () => {
    const { screen, controller, actions } = await findChoices([], undefined, true);
    try {
      expect(actions.inspectPlatformTarget.mock.calls[0]?.[1]).toMatchObject({ credentialRef: account, hostname: 'docs.happier.dev' });
      expect((await tunnelSelect(screen))?.props.selectedId).not.toBeNull();
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('offers a new tunnel Happier manages when the zone has none, already chosen, and adds the Domain with it', async () => {
    const { screen, controller, actions } = await findChoices([]);
    try {
      await vi.waitFor(async () => expect((await tunnelSelect(screen))?.props.items).toHaveLength(1));
      // One Advanced section: the connector overrides open with the form's own, not under a second Advanced.
      expect(screen.findByTestId(`${id}.ingress.advanced.header`)).toBeNull();
      await screen.pressByTestIdAsync(`${id}.advanced.header`);
      expect(screen.findByTestId(`${id}.ingress.imageRef`)).not.toBeNull();
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: expect.objectContaining({ ingress: created }),
      })));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('opens the serving Machine administrator setup when adding a Tunnel Domain is refused', async () => {
    const openRecovery = vi.fn();
    const addDomain = vi.fn(async () => ({ ok: false, error: 'admin_access_unavailable', details: {
      step: 'native_execution', machineId: 'tunnel-origin',
      operation: { serverId: scope.serverId, machineId: 'controller-machine', operationId: 'domain-operation' },
    } }));
    const { screen, controller, settle } = await findChoices([], undefined, false, { addDomain, openRecovery });
    try {
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: expect.objectContaining({ ingress: created }),
      })));
      expect(await settle(`${id}.outcome`)).not.toBeNull();
      const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
      const banner = screen.findAllByType(AttentionBanner)
        .find(node => String(node.props.testID).startsWith('project-deployments.outcome.refused'));
      await act(async () => { banner?.props.action?.onPress(); });
      expect(openRecovery).toHaveBeenCalledExactlyOnceWith('machineAdminAccess', { machineId: 'tunnel-origin' });
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('starts on the new tunnel, listed first, and keeps the existing tunnels to change it (PAGE-ACCEPT R6-D3)', async () => {
    const { screen, controller, actions } = await findChoices([{ label: 'office', selection: adopted }]);
    try {
      await vi.waitFor(async () => expect((await tunnelSelect(screen))?.props.items).toHaveLength(2));
      const select = await tunnelSelect(screen);
      expect(select?.props.selectedId).toBe(select?.props.items[0].id);
      expect(select?.props.items[1].title).toBe('office');
      await screen.pressByTestIdAsync(`${id}.save`);
      await vi.waitFor(() => expect(actions.addDomain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        content: expect.objectContaining({ ingress: created }),
      })));
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('offers no certificate choice for a tunnel Domain (PAGE-ACCEPT R6-D4)', async () => {
    const { screen, controller } = await findChoices([]);
    try {
      await screen.pressByTestIdAsync(`${id}.advanced.header`);
      // Cloudflare answers visitors at its edge with its own certificate; the sign-in name still applies at the origin.
      expect(screen.findByTestId(`${id}.certificate:custom`)).toBeNull();
      expect(screen.findByTestId(`${id}.basicAuth`)).not.toBeNull();
      // The check that applies is said instead: the record Happier writes and the outside check (R6-D2).
      await vi.waitFor(() => expect(screen.findByTestId(`${id}.tunnelCheck`)).not.toBeNull());
    } finally { await screen.unmount(); controller.retire(); }
  });

  it('never offers a Machine DNS preview for a tunnel Domain even when the Action is available', async () => {
    const previewDomainDns = vi.fn(async () => { throw new Error('Tunnel preview is not supported'); });
    const { screen, controller } = await findChoices([], previewDomainDns);
    try {
      await vi.waitFor(async () => expect((await tunnelSelect(screen))?.props.selectedId).not.toBeNull());
      expect(screen.findByTestId(`${id}.dns.action`)).toBeNull();
      expect(previewDomainDns).not.toHaveBeenCalled();
      const facts = await import('@happier-dev/deployments');
      const checkPlan = Reflect.get(facts, 'projectDeploymentDomainDraftCheckV1');
      expect(checkPlan).toBeTypeOf('function');
      expect(checkPlan(undefined, 'cloudflareTunnel')).toEqual({
        kind: 'cloudflareTunnel',
        record: { type: 'CNAME', proxied: true, destination: 'tunnel' },
        probe: 'outsideHttp',
      });
    } finally { await screen.unmount(); controller.retire(); }
  });
});

describe('Environment → Domains: an open Add domain survives a remount (PAGE-ACCEPT R6-D4, window resize)', () => {
  it('reopens with what was typed after the page remounts, and forgets it once cancelled', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, content: { ...base.content, ingress: undefined } };
    const first = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await first.settle(id)).not.toBeNull();
      await first.screen.pressByTestIdAsync(id);
      await act(async () => {
        first.screen.changeTextByTestId(`${id}.host`, 'keep.example.test');
        first.screen.changeTextByTestId(`${id}.port`, '4321');
      });
    } finally { await first.screen.unmount(); first.controller.retire(); }
    const second = await renderDomains(detail, [], domainActions(detail));
    try {
      await vi.waitFor(() => expect(second.screen.findByTestId(`${id}.host`)?.props.value).toBe('keep.example.test'));
      expect(second.screen.findByTestId(`${id}.port`)?.props.value).toBe('4321');
      await second.screen.pressByTestIdAsync(`${id}.cancel`);
    } finally { await second.screen.unmount(); second.controller.retire(); }
    const third = await renderDomains(detail, [], domainActions(detail));
    try {
      expect(await third.settle(id)).not.toBeNull();
      expect(third.screen.findByTestId(`${id}.host`)).toBeNull();
    } finally { await third.screen.unmount(); third.controller.retire(); }
  });
});
