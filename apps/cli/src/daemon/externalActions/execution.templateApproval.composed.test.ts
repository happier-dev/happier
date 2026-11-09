import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { writeStoredCredentialsForServerId } from '@/persistence';
import * as persistence from '@/persistence';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { computeExternalActionRequestEnvelopeDigestV1, decodeDeploymentChildExecutionV1, decodeReviewedActionChildHttpProofV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentReceiptResultV1Schema, DeploymentReceiptGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateV1Schema, createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DeploymentEnvironmentContentV1Schema, MachineSecretGrantV1Schema, type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { isDeploymentChildRootActionIdV1 } from '@happier-dev/protocol';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { DeploymentOwnServerTargetMachinesV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentCreateV1';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';
import { terrariaCommit, terrariaDocument, terrariaIndex } from './terrariaTemplate.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetFilesystemApprovalSocketBoundary(); resetServerFeaturesClientForTests(); });

it.each([false, true, 'profile_drift', 'builder_dispatch', 'terraria_build', 'terraria_invalid_build_output', 'credential_rotation', 'local_abort', 'remote_controller'] as const)('replays approved template through receipt reservation and retains allocated resources on binding refusal=%s', async scenario => {
  const admittedLifetime = scenario === 'credential_rotation' || scenario === 'local_abort';
  const refuseBindings = scenario === true;
  const controllerMachineId = 'machine';
  const terraria = scenario === 'terraria_build' || scenario === 'terraria_invalid_build_output';
  const retainReceipt = scenario === 'builder_dispatch' || terraria || admittedLifetime;
  const variable = terraria ? 'AUTOCREATE' : 'APP_NAME';
  const secret = terraria ? 'SERVICE_PASSWORD_TERRARIA' : 'APP_PASSWORD';
  const variableValue = terraria ? '1' : 'Approved app';
  resetServerFeaturesClientForTests();
  const actionId = 'deployments.templates.instantiate';
  const h = await createHarness(actionId, 'ask', false, 'srv_n2', undefined, false, false,
    scenario === 'remote_controller' ? { authentication: 'terminal', deploymentRuntimeMachine: true } : undefined);
  const runtimeMachineId = h.deploymentRuntime?.machineId ?? 'machine';
  const runtimeInstallation = h.deploymentRuntime?.installation ?? h.installation;
  const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const nativeDirectory = await mkdtemp(join(tmpdir(), 'happier-template-approval-'));
  const native = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
    runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
  try {
    const docker = await createOwnServerDockerBoundary(join(nativeDirectory, 'tools'));
    vi.stubEnv('PATH', `${join(nativeDirectory, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
    const image = await docker.registerImage('app', 'A');
    if (terraria) await docker.setImagePruneState(image.registryReference, {
      repoTags: ['hexlo/terraria-server-docker:1.4.5.0'],
      repoDigests: [`hexlo/terraria-server-docker@${image.manifestDigest}`],
    });
    const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
      document: 'services:\n  web:\n    image: ' + image.registryReference + '\n    environment:\n      APP_NAME: ${APP_NAME}\n      APP_PASSWORD: ${APP_PASSWORD}\n', profiles: [], services: ['web'] },
      variables: [{ key: 'APP_NAME', label: 'App name', required: true, valueKind: 'string', secret: false, sites: [{ service: 'web', path: ['environment', 'APP_NAME'] }] }, { key: 'APP_PASSWORD', label: 'Password', required: true, valueKind: 'string', secret: true, sites: [{ service: 'web', path: ['environment', 'APP_PASSWORD'] }] }], generatedSecrets: [{ key: 'APP_PASSWORD', purpose: 'password', label: 'Password', profile: { kind: 'hex-32-bytes' } }], domains: [], volumes: [] });
    const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
    const source = { id: terraria ? 'builtin:compose-catalog' : 'apps', title: 'Apps',
      format: terraria ? 'coolify-templates' as const : 'happier-catalog' as const, kinds: ['app' as const],
      url: terraria ? 'https://github.com/coollabsio/coolify' : 'https://apps.test/catalog.json', enabled: true, addedAt: 1 };
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => [{ ...source,
      origin: { kind: 'user' }, removable: true }], http: {
      getJson: async url => ({ ok: true, value: !terraria ? catalog : url.includes('/commits/') ? { sha: terrariaCommit } : terrariaIndex, fetchedAt: 1 }),
      getText: async () => { if (terraria) return { ok: true, value: terrariaDocument, fetchedAt: 1 }; throw new Error('No text request'); }, getBytes: async () => { throw new Error('No binary request'); },
    } });
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
      sourceId: source.id, itemId: terraria ? 'terraria-server' : 'app', kind: 'app' })).item;
    if (selected.payload.kind !== 'app' || selected.payload.state !== 'ready') throw new Error('Expected ready app');
    if (terraria) expect(selected.payload.ref).toEqual({ kind: 'gitTree', repo: source.url, path: '',
      commit: terrariaCommit, treeSha: '27ef1e3192da419f468adb1ee487b605c5e37d28' });
    const get = vi.mocked(axios.get).getMockImplementation()!;
    const post = vi.mocked(axios.post).getMockImplementation()!;
    const request = vi.mocked(axios.request).getMockImplementation()!;
    const boundaryErrors: string[] = [];
    const deploymentRequests: string[] = [];
    let settingsReads = 0;
    let reserved: ReturnType<typeof DeploymentReceiptResultV1Schema.parse> | undefined;
    let receipt: ReturnType<typeof createDeploymentReceiptHeaderV1> | undefined;
    const builderRequests: string[] = [];
    const admittedRuntimeReads: Array<Readonly<{ path: string; effect: 'template-root' | 'deployment-child' }>> = [];
    let rootRequestId: string | undefined;
    let rootMachineId: string | undefined;
    let bindingWrites = 0;
    let persistedGrants: MachineSecretGrantV1[] = [];
    let generated: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse> | undefined;
    const documents = new Map<string, Record<string, unknown>>();
    let rotated = false;
    const credentialReadOrigins: string[] = [];
    const readStoredCredentials = persistence.readStoredCredentialsForServerId;
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockImplementation(serverId => {
      if (reserved) credentialReadOrigins.push(new Error().stack ?? 'missing credential read stack');
      return readStoredCredentials(serverId);
    });
    const nativeChildren: string[] = [];
    if (admittedLifetime) h.onDeploymentChildDelivery(async (child, result) => {
      nativeChildren.push(child.kind);
      if (child.kind !== 'build' || !result || typeof result !== 'object' || !('ok' in result) || !result.ok) return;
      rotated = true;
      const nextToken = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 2,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
      // Re-login changes only the real profile after the native builder's signed result.
      await writeStoredCredentialsForServerId('srv_n2', { token: nextToken, encryption: null,
        credentialProvenance: 'stored_session' });
      if (scenario === 'local_abort') expect(await h.cancelOperation(child.actionOperationId!)).toEqual({ kind: 'requested' });
    });
    const environment = createDeploymentEnvironmentDetailV1();
    Object.assign(environment.environment, { id: 'approved-environment', serverId: 'srv_n2', projectSourceId: 'project',
      owner: { kind: 'account', accountId: 'account' }, controllerMachineId, buildMachineId: 'machine' });
    const target = environment.targetLinks[0]!.targetLink;
    Object.assign(target, { environmentId: environment.environment.id, activeDeploymentId: undefined, machines: [runtimeMachineId],
      members: [{ machineId: runtimeMachineId, installationId: runtimeInstallation.installationId, state: admittedLifetime ? 'active' : 'joining' }] });
    environment.environment.runtimeTargetLinkId = target.id;
    // Only Home/catalog HTTP is substituted. The installed daemon, requester
    // admission, Settings publication, durable approval and template preparation run real.
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (scenario === 'remote_controller' && path === `/v1/machines/${runtimeMachineId}`) {
        expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('template-home-root');
        const effectActionId = config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
        const childHeader = config?.headers?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER];
        const child = childHeader === undefined ? null : decodeDeploymentChildExecutionV1(String(childHeader), 'template-home-root');
        if (childHeader === undefined) {
          expect(effectActionId).toBe(actionId);
        } else {
          expect(effectActionId).toBe('deployments.deploy');
          expect(child?.externalActionExecution.deploymentChildRouting).toMatchObject({
            actionId: 'deployments.deploy', machineId: runtimeMachineId, installationId: runtimeInstallation.installationId,
            input: { serverId: 'srv_n2', environmentId: environment.environment.id, targetLinkId: target.id } });
        }
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'template-home-root',
          effectActionId: childHeader === undefined ? actionId : 'deployments.deploy',
          target: { kind: 'machine', machineId: controllerMachineId }, installationId: h.installation.installationId,
          requestId: rootRequestId!, method: 'GET', path, ...(child ? { deploymentChildExecution: child } : {}),
          signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
          publicKey: Buffer.from(h.installation.publicKey, 'base64url') })).toBe(true);
        admittedRuntimeReads.push({ path, effect: childHeader === undefined ? 'template-root' : 'deployment-child' });
        return await get(url, config);
      }
      if (scenario === 'builder_dispatch' && receipt?.state === 'running' && path === '/v1/machines/machine') {
        builderRequests.push(`GET ${path}`);
        // The real transport must reach the exact builder lookup. Stop at its
        // network boundary before any native effects or receiver work begins.
        return { status: 200, data: { machine: { id: 'machine', revokedAt: 1 } } };
      }
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: generated ? [{ resourceId: generated.resourceId, encryptionMode: generated.encryptionMode, storedContent: generated.storedContent, recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1(generated.resourceId), source: 'shared_resource', relationship: 'owner', ownerAccountId: 'account', name: generated.displayName, kind: generated.kind, revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] : [] } };
      const document = documents.get(decodeURIComponent(path.slice('/v1/artifacts/'.length)));
      if (path.startsWith('/v1/artifacts/') && document) {
        return { status: 200, data: document };
      }
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({
        status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: key === 'registry-sources'
          ? { t: 'plain', v: { key, value: { v: 2, sources: [source], disabledSourceIds: [] } } } : null })),
      }) };
      const response = await get(url, config).catch(error => { boundaryErrors.push(String(error.stack ?? error)); throw error; });
      if (path !== '/v2/account/settings') return response;
      settingsReads++;
      return { ...response, data: { ...response.data, content: { t: 'plain', v: { ...response.data.content.v,
        deploymentDefaultsV1: { controllerMachineId, buildMachineId: 'machine', retainPreviousDeployments: 7 },
      } } } };
    });
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (String(url).endsWith('/v1/account/saved-secrets/resources')) { generated = SharedSavedSecretCreateInputV1Schema.parse(body); return { status: 200, data: { resourceId: generated.resourceId, revision: 1 } }; }
      if (String(url).endsWith('/v1/plugins/availability/intents/list')) {
        const { knownPluginIds: pluginIds } = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
        return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
          pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId, response: {
            availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
          } })),
        }) };
      }
      if (String(url).endsWith(`/v1/actions/${actionId}/execution-authorization`)) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        rootRequestId = request.envelope.requestId;
        rootMachineId = request.machineId;
        const deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: request.envelope });
        return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-home-root', binding: {
          accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'terminal', tokenEpoch: 1 },
          admittedMachineRole: 'manage', accountEncryptionMode: 'plain', serverIdentityId: 'srv_n2', machineId: 'machine',
          installationId: h.installation.installationId, actionId, requestId: request.envelope.requestId,
          target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          deploymentPreparationAdmission,
          ...(isDeploymentChildRootActionIdV1(actionId, deploymentPreparationAdmission) ? { deploymentChildRoot: true } : {}),
        } }) };
      }
      try { return await post(url, body, config); }
      catch (error) { boundaryErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
    });
    vi.mocked(axios.request).mockImplementation(async input => {
      const path = new URL(String(input.url)).pathname;
      deploymentRequests.push(`${input.method} ${path} ${input.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]}`);
      if (input.method === 'POST' && path.endsWith('/deploy')) {
        const headers = input.headers;
        expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('template-home-root');
        expect(headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('deployments.deploy');
        const reviewedChild = decodeReviewedActionChildHttpProofV1(String(headers?.[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]));
        expect(reviewedChild?.role).toBe('template.deploy');
        const { actionOperationId: _operation, ...nativeInput } = readCarrierMutation(input.data);
        expect(reviewedChild?.inputDigest).toBe(computeActionInputApprovalDigestV1('deployments.deploy', nativeInput));
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'template-home-root', effectActionId: 'deployments.deploy',
          target: { kind: 'machine', machineId: 'machine' }, installationId: h.installation.installationId,
          requestId: rootRequestId!, method: 'POST', path, body: input.data, reviewedChild: reviewedChild!,
          signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: Buffer.from(h.installation.publicKey, 'base64url') })).toBe(true);
        // Home's accepted-execution boundary requires the signed executor to be
        // the persisted controller; runtime/build placement does not grant it.
        if (rootMachineId !== environment.environment.controllerMachineId)
          return { status: 200, data: { ok: false, error: 'deployment_access_denied' } };
        reserved = DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: environment.environment.id,
          deploymentId: 'approved-template-receipt', revision: environment.environment.revision + 1, deploymentRevision: 1, state: 'queued' });
        if (retainReceipt) {
          const body = readCarrierMutation(input.data);
          receipt = createDeploymentReceiptHeaderV1({ id: 'approved-template-receipt', environmentId: environment.environment.id,
            targetLinkId: target.id, revision: 1, state: 'queued', requestKey: String(body.requestKey),
            actionOperationId: String(body.actionOperationId), contentArtifactId: String(body.contentArtifactId),
            contentHeaderVersion: Number(body.contentHeaderVersion), contentBodyVersion: Number(body.contentBodyVersion),
            acceptedExecution: { v: 1, controller: { machineId: 'machine', installationId: h.installation.installationId },
              builder: { machineId: 'machine', installationId: h.installation.installationId } } });
        }
        return { status: 200, data: reserved };
      }
      // Receipt reservation is the composed boundary under test. Model Home
      // becoming unavailable afterwards without substituting native domain logic.
      if (input.method === 'GET' && path === '/v1/deployments/receipts/approved-template-receipt')
        return retainReceipt
          ? { status: 200, data: DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt }) }
          : { status: 503, data: { ok: false, error: 'deployment_unavailable' } };
      if (retainReceipt && receipt && input.method === 'POST' && path.endsWith('/transitions')) {
        const body = readCarrierMutation(input.data);
        const mutation = readCarrierMutation(body.contentUpdate);
        const document = documents.get(receipt.contentArtifactId)!;
        Object.assign(document, mutation, { headerVersion: Number(document.headerVersion) + 1,
          bodyVersion: Number(document.bodyVersion) + 1 });
        const transitioned = DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: { ...receipt,
          state: admittedLifetime ? body.state : body.state === 'running' ? 'running' : 'failed', revision: receipt.revision + 1,
          contentHeaderVersion: Number(document.headerVersion), contentBodyVersion: Number(document.bodyVersion) } });
        if (!transitioned.ok) throw new Error('Invalid boundary receipt transition');
        receipt = transitioned.deployment;
        if (admittedLifetime && receipt.state === 'succeeded') target.activeDeploymentId = receipt.id;
        return { status: 200, data: DeploymentReceiptResultV1Schema.parse({ ok: true,
          environmentId: environment.environment.id, deploymentId: receipt.id, revision: environment.environment.revision,
          deploymentRevision: receipt.revision, state: receipt.state }) };
      }

      if (path.endsWith('/secret-launch-admission') && readCarrierMutation(input.data).materialization && readCarrierMutation(readCarrierMutation(input.data).materialization).kind !== 'bindings') {
        if (scenario === 'terraria_invalid_build_output' && readCarrierMutation(readCarrierMutation(input.data).materialization).kind === 'deployment') {
          return { status: 200, data: { ok: true, grants: [{ ...persistedGrants[0], sealedContent: { value: 'never-record-secret-output' } }] } };
        }
        return { status: 200, data: { ok: true, grants: persistedGrants } };
      }
      if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [], bindingPreparation: { runtimeInstallations: [{ machineId: runtimeMachineId, installationId: runtimeInstallation.installationId, publicKey: runtimeInstallation.publicKey }], buildInstallation: { machineId: 'machine', installationId: h.installation.installationId, publicKey: h.installation.publicKey } } } };
      if (input.method === 'POST' && path === '/v1/account/saved-secrets/resources') { generated = SharedSavedSecretCreateInputV1Schema.parse(input.data); return { status: 200, data: { resourceId: generated.resourceId, revision: 1 } }; }
      if (input.method === 'POST' && (path === '/v1/deployments/environments' || path.endsWith('/bindings'))) {
        const body = readCarrierMutation(input.data);
        if (path.endsWith('/bindings') && refuseBindings) return { status: 409, data: { ok: false, error: 'deployment_content_unavailable' } };
        Object.assign(environment.environment, { contentArtifactId: body.contentArtifactId,
          contentHeaderVersion: body.contentHeaderVersion, contentBodyVersion: body.contentBodyVersion,
          revision: environment.environment.revision + 1 });
        if (path.endsWith('/bindings')) {
          bindingWrites++;
          if (!Array.isArray(body.grants)) throw new Error('Expected persisted binding grants');
          persistedGrants = body.grants.map(grant => MachineSecretGrantV1Schema.parse(grant));
        }
        if (body.firstTargetLink) {
          const firstTargetLink = readCarrierMutation(body.firstTargetLink);
          const machines = DeploymentOwnServerTargetMachinesV1Schema.parse(firstTargetLink.machines);
          Object.assign(target, firstTargetLink, { machines: machines.map(member => member.machineId),
            members: machines.map(member => ({ ...member, state: admittedLifetime ? 'active' : 'joining' })) });
        }
        return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision } };
      }
      if (input.method === 'GET' && path === `/v1/deployments/environments/${environment.environment.id}/deployments`) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
      if (input.method === 'GET' && path === '/v1/deployments/environments/' + environment.environment.id) {
        // Author preparation uses environments.get. A reviewed native child
        // retains deployments.deploy; Home's template purpose owns that route.
        const effect = input.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
        const reviewed = decodeReviewedActionChildHttpProofV1(String(input.headers?.[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]));
        const child = decodeDeploymentChildExecutionV1(String(input.headers?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]),
          String(input.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] ?? ''));
        const native = child?.externalActionExecution.deploymentChildRouting;
        if (effect !== 'deployments.environments.get' && !(effect === 'deployments.deploy' && (reviewed?.role === 'template.deploy'
          || native?.actionId === 'deployments.deploy' && native.input.environmentId === environment.environment.id)))
          return { status: 403, data: { error: 'action_forbidden' } };
        return { status: 200, data: { ok: true, environment: environment.environment, targetLinks: [target] } };
      }
      if (input.method === 'GET' && path === '/v1/projects/sources/project') return { status: 200, data: { ok: true, canManage: true,
        source: { id: 'project', revision: 2, name: 'Project', owner: { kind: 'account', accountId: 'account' },
          audience: [], createdByAccountId: 'account' } } };
      if (input.method === 'GET' && path === '/v1/projects/project/deployment-defaults') return { status: 200, data: {
        ok: true, projectSourceId: 'project', sourceRevision: 2, revision: 0, content: null } };
      return request(input).catch(error => { boundaryErrors.push(String(error.stack ?? error)); throw error; });
    });
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, options) => terraria && String(url).startsWith('https://raw.githubusercontent.com/coollabsio/coolify/')
      ? String(url).endsWith('.json') ? Response.json(terrariaIndex) : new Response(terrariaDocument)
      : String(url) === source.url ? Response.json(catalog) : fetch(url, options).catch(error => { boundaryErrors.push(String(error.stack ?? error)); throw error; }));
    const installArtifactBoundary = () => {
      const admittedPost = vi.mocked(axios.post).getMockImplementation()!;
      // Persist Home Artifact bytes independently from the durable approval Artifact.
      vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
        if (String(url).endsWith('/v1/artifacts')) {
          const document = readCarrierMutation(body);
          documents.set(String(document.id), { ...document, ownerAccountId: 'account', access: 'owner',
            encryptionMode: 'plain', publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
          return { status: 200, data: { id: document.id, headerVersion: 1, bodyVersion: 1 } };
        }
        const document = documents.get(decodeURIComponent(new URL(String(url)).pathname.slice('/v1/artifacts/'.length)));
        if (document) {
          const mutation = readCarrierMutation(body);
          if (mutation.header !== undefined) { document.header = mutation.header; document.headerVersion = Number(document.headerVersion) + 1; }
          if (mutation.body !== undefined) { document.body = mutation.body; document.bodyVersion = Number(document.bodyVersion) + 1; }
          for (const key of ['provenance', 'provenanceDataEncryptionKey']) if (mutation[key] !== undefined) document[key] = mutation[key];
          return { status: 200, data: { success: true, headerVersion: document.headerVersion, bodyVersion: document.bodyVersion } };
        }
        try { return await admittedPost(url, body, config); }
        catch (error) { boundaryErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
      });
    };
    const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', deploy: { requestKey: 'approved-template-deploy' }, managedRetention: 'keep', serverId: 'srv_n2', machineId: runtimeMachineId,
      projectSourceId: 'project', templateRef: { sourceId: source.id, itemId: selected.summary.itemId, version: selected.summary.version!, ref: selected.payload.ref },
      environment: { kind: 'create', name: 'App', requestKey: 'approved-template-settings', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId }, target: { kind: 'new', installationId: runtimeInstallation.installationId },
      destination: { kind: 'stored' }, generatedSecretAudience: { accountGrants: ['account'] }, bindings: [{ purpose: 'variable', name: variable, phase: 'runtime', source: { kind: 'value', value: variableValue } }, { purpose: 'variable', name: secret, phase: 'runtime', source: { kind: 'generated', key: secret } },
        ...(terraria ? [{ purpose: 'variable', name: 'MAXPLAYERS', phase: 'runtime', source: { kind: 'value', value: '2' } }] : [])] });
    const asked = await h.runOriginalCli(input, actionId);
    expect(asked, JSON.stringify({ asked, paths: h.networkPaths, boundaryErrors })).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created' } });
    expect((await h.approval()).status).toBe('open');
    const readsBeforeDecision = settingsReads;
    const boundaryOutcomesBeforeDecision = h.rpcOutcomes.length;
    installArtifactBoundary();
    const foreignAccountRequests: string[] = [];
    if (scenario === 'profile_drift') {
      const otherToken = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'other-account', tokenEpoch: 1,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url') + '.signature';
      // Change only the real profile file, after the Account A approval exists.
      // Home must not disclose A's approval to a request authenticated as X.
      await writeStoredCredentialsForServerId('srv_n2', { token: otherToken, encryption: null,
        credentialProvenance: 'stored_session' });
      const accountGet = vi.mocked(axios.get).getMockImplementation()!;
      vi.mocked(axios.get).mockImplementation(async (url, config) => {
        if (config?.headers?.Authorization === `Bearer ${otherToken}`) {
          foreignAccountRequests.push(`GET ${new URL(String(url)).pathname}`);
          return { status: 404, data: { error: 'not_found' } };
        }
        return accountGet(url, config);
      });
      const accountPost = vi.mocked(axios.post).getMockImplementation()!;
      vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
        if (config?.headers?.Authorization === `Bearer ${otherToken}`) {
          foreignAccountRequests.push(`POST ${new URL(String(url)).pathname}`);
          return { status: 403, data: { error: 'account_mismatch' } };
        }
        return accountPost(url, body, config);
      });
      const accountRequest = vi.mocked(axios.request).getMockImplementation()!;
      vi.mocked(axios.request).mockImplementation(async config => {
        if (config.headers?.Authorization === `Bearer ${otherToken}`) {
          foreignAccountRequests.push(`${config.method} ${new URL(String(config.url)).pathname}`);
          return { status: 403, data: { error: 'account_mismatch' } };
        }
        return accountRequest(config);
      });
    }
    const decided = await h.decideFromCli();
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
    const after = await h.approval();
    expect(foreignAccountRequests).toEqual([]);
    expect(after.decision?.kind).toBe('approve');
    expect(generated, JSON.stringify({ execution: after.execution, boundaryErrors, paths: h.networkPaths })).toBeDefined();
    const sourceRef = { kind: 'secret', ref: formatSharedSavedSecretRefV1(generated!.resourceId), resourceRevision: 1 };
    if (refuseBindings) {
      expect(after.execution, JSON.stringify({ execution: after.execution, boundaryErrors })).toMatchObject({ effectAttempted: true,
        ok: false, errorCode: 'deployment_content_unavailable', details: { kind: 'partial', phase: 'bindings',
          environmentId: environment.environment.id, targetLinkId: target.id, revision: environment.environment.revision,
          savedSecrets: [{ name: secret, phase: 'runtime', source: sourceRef }] } });
      expect(bindingWrites).toBe(0);
      expect(reserved).toBeUndefined();
    } else {
      expect(reserved, JSON.stringify({ execution: after.execution, rootMachineId, controllerMachineId, boundaryErrors, deploymentRequests,
        native: (await docker.readInvocations()).map(value => value.args) })).toMatchObject({ ok: true,
        environmentId: environment.environment.id, deploymentId: 'approved-template-receipt', state: 'queued' });
      if (scenario === 'remote_controller') {
        expect(rootMachineId).toBe(controllerMachineId);
        expect(admittedRuntimeReads).toEqual(expect.arrayContaining([
          { path: `/v1/machines/${runtimeMachineId}`, effect: 'template-root' },
          { path: `/v1/machines/${runtimeMachineId}`, effect: 'deployment-child' },
        ]));
        expect(target.members).toEqual([{ machineId: runtimeMachineId,
          installationId: runtimeInstallation.installationId, state: 'joining' }]);
      }
      if (scenario === 'builder_dispatch') {
        const refusals = warnings.mock.calls.filter(([message]) => message === '[Deployment] child dispatch refused');
        expect(refusals).toHaveLength(0);
        expect(JSON.stringify(refusals)).not.toContain('template-home-root');
        expect(builderRequests, JSON.stringify({ execution: after.execution,
          refusals, boundaryErrors, deploymentRequests })).toEqual(['GET /v1/machines/machine']);
      }
      if (terraria) {
        const document = documents.get(receipt!.contentArtifactId)!;
        const body = ArtifactBodyEnvelopeV1StoredSchema.parse(decodePlainArtifactStoredContent(String(document.body)));
        const content = typeof body.body === 'string' ? JSON.parse(body.body) : null;
        if (scenario === 'terraria_invalid_build_output') {
          expect(content?.failure).toMatchObject({ code: 'invalid_action_output', phase: 'build', validation: {
            source: 'environment_secret_launch_admission', httpStatus: 200,
            issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_type', path: ['grants', 0, 'sealedContent'] })]),
          } });
          expect(JSON.stringify(content?.failure)).not.toContain('never-record-secret-output');
        } else {
          expect(content?.ownServer).toMatchObject({ buildSecretRevisions: [], imageArchives: expect.any(Array) });
          expect(h.rpcOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, state: 'running', deploymentRevision: 6 })]));
        }
      }
      if (admittedLifetime) {
        const stored = documents.get(receipt!.contentArtifactId)!;
        const storedBody = ArtifactBodyEnvelopeV1StoredSchema.parse(decodePlainArtifactStoredContent(String(stored.body)));
        expect(rotated, JSON.stringify({ execution: after.execution, receipt, nativeChildren, boundaryErrors,
          content: storedBody.body, rpc: h.rpcOutcomes, warnings: warnings.mock.calls })).toBe(true);
        expect(nativeChildren).toContain('build');
        if (scenario === 'credential_rotation') {
          expect(after.execution, JSON.stringify({ receipt, nativeChildren, boundaryErrors, content: storedBody.body,
            rpc: h.rpcOutcomes, warnings: warnings.mock.calls })).toMatchObject({ ok: true });
          expect(receipt?.state).toBe('succeeded');
          expect(nativeChildren).toContain('member');
          // Operation snapshot publication has separate Account privacy custody.
          // Count only the admitted deployment's installed-runtime/archive checks.
          const deploymentCredentialReads = credentialReadOrigins.filter(stack => /resolveInstalledAccountRuntime|assertInstalledCurrent|imageArchiveCopy/.test(stack));
          const readOrigins = new Map<string, number>();
          for (const stack of credentialReadOrigins) {
            const origin = stack.split('\n').slice(2, 6).join('\n');
            readOrigins.set(origin, (readOrigins.get(origin) ?? 0) + 1);
          }
          console.info('Admitted deployment credential read measurement', { total: credentialReadOrigins.length,
            deployment: deploymentCredentialReads.length, origins: [...readOrigins] });
          expect(deploymentCredentialReads,
            credentialReadOrigins.join('\n')).toEqual([]);
        } else {
          expect(await h.readOperation(receipt!.actionOperationId)).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
          expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
        }
      } else expect(after.execution).toMatchObject({ effectAttempted: true, ok: false,
        errorCode: scenario === 'builder_dispatch' ? 'machine_target_not_current'
          : scenario === 'terraria_invalid_build_output' ? 'invalid_action_output'
          : retainReceipt ? 'deployment_failed' : 'deployment_unavailable',
        details: { kind: 'partial', phase: 'deploy', environmentId: environment.environment.id, targetLinkId: target.id,
          savedSecrets: [{ name: secret, phase: 'runtime', source: sourceRef }] } });
      expect(bindingWrites).toBe(1);
    }
    const committed = documents.get(environment.environment.contentArtifactId)!;
    if (typeof committed.body !== 'string') throw new Error('Expected stored content bytes');
    const body = ArtifactBodyEnvelopeV1StoredSchema.parse(decodePlainArtifactStoredContent(committed.body));
    if (typeof body.body !== 'string') throw new Error('Expected JSON content');
    const content = DeploymentEnvironmentContentV1Schema.parse(JSON.parse(body.body));
    expect(content.bindings).toEqual(refuseBindings ? [] : expect.arrayContaining([
      expect.objectContaining({ name: variable, source: { kind: 'value', value: variableValue } }),
      expect.objectContaining({ name: secret, source: sourceRef }),
      ...(terraria ? [expect.objectContaining({ name: 'MAXPLAYERS', source: { kind: 'value', value: '2' } })] : []),
    ]));
    expect(boundaryErrors).toEqual([]);
    if (scenario === 'remote_controller') {
      // Replay and each installed review acquire their own requester Settings projection.
      const receiverAdmissions = h.rpcOutcomes.slice(boundaryOutcomesBeforeDecision).filter(value =>
        value && typeof value === 'object' && 'phase' in value
        && (value.phase === 'fixture.settingsRead' || value.phase === 'fixture.deploymentChildReceive'));
      expect(receiverAdmissions).toEqual([
        { phase: 'fixture.settingsRead', installationId: h.installation.installationId },
        { phase: 'fixture.deploymentChildReceive', machineId: runtimeMachineId,
          installationId: runtimeInstallation.installationId, kind: 'review' },
        { phase: 'fixture.settingsRead', installationId: runtimeInstallation.installationId },
        { phase: 'fixture.deploymentChildReceive', machineId: runtimeMachineId,
          installationId: runtimeInstallation.installationId, kind: 'review' },
        { phase: 'fixture.settingsRead', installationId: runtimeInstallation.installationId },
      ]);
    } else if (!admittedLifetime) {
      // The restored original-root admission reads once; deployment consumers reuse it.
      expect(settingsReads - readsBeforeDecision).toBe(scenario === 'terraria_build' ? 3 : scenario === 'terraria_invalid_build_output' ? 2 : 1);
    }
  } finally { await native.dispose(); await h.close(); await rm(nativeDirectory, { recursive: true, force: true }); }
}, 120_000);
