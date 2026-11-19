import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  AutomationStoredWorkflowDefinitionV2Schema, DeploymentEnvironmentCreateResultV1Schema,
  DeploymentEnvironmentCreateStorageInputV1Schema, DeploymentReceiptResultV1Schema,
  DeploymentTargetLinkInputV1Schema, DeploymentTargetLinkResultV1Schema,
  FeaturesResponseSchema, computeDeploymentTransitionRequestDigestV1, DeploymentActionOutputSchemasV1,
  DeploymentDomainAddAdmissionInputV1Schema, DeploymentDomainContentV1Schema,
  DeploymentDomainMutationResultV1Schema, deploymentDomainObservationProofPayloadV1,
  sealAccountScopedBlobCiphertext, signMachineInstallationProof, type DeploymentTransitionInputV1,
} from '@happier-dev/protocol';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { encodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { ProjectSourcesCreateInputV1Schema, ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema }
  from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { DeploymentEnvironmentContentV1Schema, DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import {
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
  DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
} from '@happier-dev/deployment-protocol';

import { prepareExternalActionRequesterAccountAuthorizationResult, createExternalActionAuthorizedRequestHeaders }
  from '../../../../../apps/cli/src/api/externalActionExecutionAuthorization';
import { readAccountIdFromToken, readCredentialEpochFromToken } from '../../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createEncryptedArtifactViaApi } from '../artifactApi';
import type { TestAuth } from '../auth';
import type { TestAccountCliAuthCredentials } from '../cliAuth';
import { fetchJson } from '../http';
import type { MachineInstallationIdentityFixture } from '../machineIdentity';

/** Signed records only: this fixture never invokes an Action executor or a native deployment. */
export async function seedDeployPreview(params: Readonly<{
  baseUrl: string; auth: TestAuth; machineId: string; installation: MachineInstallationIdentityFixture;
  credentials: Extract<TestAccountCliAuthCredentials, { encryption: unknown }>;
}>) {
  const { baseUrl, auth, machineId, installation, credentials } = params;
  let artifactsCreated = 0;
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const post = async (path: string, body: unknown, authorizationHeaders: Readonly<Record<string, string>> = headers) => {
    const response = await fetchJson<unknown>(`${baseUrl}${path}`, {
      // Authorization also carries host-local Symbol metadata; only named headers cross HTTP.
      method: 'POST', headers: Object.fromEntries(Object.entries(authorizationHeaders)), body: JSON.stringify(body),
    });
    if (response.status !== 200) {
      const code = readRecord(response.data)?.error;
      throw new Error(`QA preview record write ${path} failed (status=${response.status}, code=${typeof code === 'string' ? code : 'unknown'})`);
    }
    return response.data;
  };
  const artifact = async (kind: string, title: string, content: unknown) => {
    const saved = await createEncryptedArtifactViaApi({ baseUrl, token: auth.token, artifactId: randomUUID(),
      kind: encodeArtifactKindV1({ kind: 'other', kindHint: kind }),
      headerJson: { kind, title }, bodyJson: { body: JSON.stringify(content) }, cliAccessKey: credentials });
    artifactsCreated++;
    return { contentArtifactId: saved.id, contentHeaderVersion: saved.headerVersion, contentBodyVersion: saved.bodyVersion };
  };
  const features = FeaturesResponseSchema.parse((await fetchJson<unknown>(`${baseUrl}/v1/features`)).data);
  const serverId = features.capabilities.serverIdentity.serverIdentityId;
  const accountId = readAccountIdFromToken(auth.token);
  const tokenEpochHint = readCredentialEpochFromToken(auth.token);
  if (!accountId || tokenEpochHint === null) throw new Error('QA preview requires its fresh E2EE Account');
  const source = ProjectSourcesCreateOutputV1Schema.parse(await post('/v1/projects/sources', ProjectSourcesCreateInputV1Schema.parse({
    serverId, requestKey: randomUUID(), name: 'QA preview records only', owner: { kind: 'account', accountId }, defaultRef: 'main',
    repository: { provider: { id: 'github', kind: 'github', displayName: 'QA fixture forge', baseUrl: 'https://github.example' },
      repository: { nameWithOwner: 'qa/preview-records-only', cloneUrl: 'https://github.example/qa/preview-records-only.git',
        webUrl: 'https://github.example/qa/preview-records-only', defaultBranch: 'main', visibility: 'private' }, protocol: 'https' },
  })));
  if (!source.ok) throw new Error(`QA preview Source refused: ${source.error}`);
  const projectSourceId = source.source.id;
  const projectId = randomUUID();
  const projectCipher = createProjectAccountRowCipherV1({ mode: 'e2ee',
    material: { type: 'dataKey', machineKey: auth.accountMachineKey }, randomBytes });
  const project = ProjectAccountRowMutationResponseV1Schema.parse(await post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`,
    ProjectAccountRowMutationRequestV1Schema.parse({ topologyChange: true, expectedRefs: [], mutations: [
      { key: { kind: 'workspace-ref', serverId, id: projectId }, expectedRevision: 'absent',
        content: projectCipher.seal({ key: { kind: 'workspace-ref', serverId, id: projectId }, value: {
          id: projectId, serverId, machineId, rootPath: '/home/qa/records-only', label: 'QA preview records only',
          createdAtMs: Date.now(), projectKey: projectId, source: { sourceId: projectSourceId, revision: source.source.revision },
        } }) },
      { key: { kind: 'relationship-graph' }, expectedRevision: 'absent',
        content: projectCipher.seal({ key: { kind: 'relationship-graph' }, value: { relationships: [] } }) },
    ] })));
  if (project.status !== 'updated') throw new Error(`QA preview Project refused: ${project.status}`);
  const document = 'services:\n  app:\n    image: example.invalid/qa-records-only:fixture\n';
  const definition = { kind: 'stored' as const, contentRevision: 1, document,
    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'], primaryService: 'app' };
  const environment = async (name: string, purpose: 'standard' | 'preview', preview?: {
    templateEnvironmentId: string; expectedTemplateRevision: number; pullRequestId: string; runtimeTargetLinkId: string;
  }) => {
    const content = DeploymentEnvironmentContentV1Schema.parse({ name, retainPreviousDeployments: 1, definition, bindings: [] });
    const created = DeploymentEnvironmentCreateResultV1Schema.parse(await post('/v1/deployments/environments',
      DeploymentEnvironmentCreateStorageInputV1Schema.parse({ serverId, projectSourceId, requestKey: randomUUID(),
        protection: purpose === 'standard' ? 'production' : 'nonProduction', purpose, deployerMode: 'managers',
        controllerMachineId: machineId, buildMachineId: machineId, ...(preview ? { preview } : {}),
        ...await artifact(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, name, content) })));
    if (!created.ok) throw new Error(`QA preview Environment refused: ${created.error}`);
    const linked = DeploymentTargetLinkResultV1Schema.parse(await post(`/v1/deployments/environments/${created.environmentId}/targets`,
      DeploymentTargetLinkInputV1Schema.parse({ serverId, environmentId: created.environmentId,
        expectedRevision: created.revision, requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
        machines: [{ machineId, installationId: installation.installationId }],
        ...await artifact(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, `${name} records-only target`, {}) })));
    if (!linked.ok) throw new Error(`QA preview TargetLink refused: ${linked.error}`);
    return linked;
  };
  const production = await environment('Production', 'standard');
  // Preview relation admission consumes a saved enabled Workflow. Zero triggers means this fixture cannot schedule work.
  const workflow = AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace: { directory: '/home/qa/records-only' },
    executionTarget: { kind: 'session' }, inlineDefinition: { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }, blocks: [{ kind: 'step', id: 'fixture', document: { text: 'Records-only fixture; never scheduled.', references: [], attachments: [] },
      input: [], result: { kind: 'text' } }] } });
  await post('/v3/automations', AutomationDefinitionCreateRequestSchema.parse({ automationId: randomUUID(),
    name: 'QA preview admission records only', enabled: true, triggers: [], assignments: [{ machineId }], executionRecipe: {
      v: 2, templateVersion: 1, triggerEvidence: null, deploymentEnvironment: {
        serverId, projectSourceId, environmentId: production.environmentId, previewRole: 'preview_admission',
      }, workflow: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
        material: { type: 'dataKey', machineKey: auth.accountMachineKey }, payload: workflow, randomBytes }) },
    } }));
  const preview = await environment('Preview PR 17 (records only)', 'preview', { templateEnvironmentId: production.environmentId,
    expectedTemplateRevision: production.revision, pullRequestId: '17', runtimeTargetLinkId: production.targetLinkId });
  const privateKey = Uint8Array.from(Buffer.from(installation.privateKeyBase64, 'base64url'));
  const receiptContent = DeploymentOwnServerContentV1Schema.parse({ sourceIntent: definition, machines: [machineId], buildMachineId: machineId,
    onFailure: 'keepPartial', images: [], machineResults: [], steps: [] });
  const input = { serverId, environmentId: preview.environmentId, expectedRevision: preview.revision,
    targetLinkId: preview.targetLinkId, expectedTargetLinkRevision: preview.targetLinkRevision, requestKey: randomUUID(),
    ...await artifact(DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Records-only preview receipt; no workload or health observation', receiptContent) };
  const target = { kind: 'machine' as const, machineId };
  const prepared = await prepareExternalActionRequesterAccountAuthorizationResult({ actionId: 'deployments.deploy', input,
    requestId: randomUUID(), target, machineId, accountId, accountEncryptionMode: 'e2ee', tokenEpochHint, token: auth.token,
    material: { type: 'dataKey', machineKey: auth.accountMachineKey }, serverId, serverIdentityId: serverId, serverHttpBaseUrl: baseUrl,
    installationId: installation.installationId, privateKey });
  if (!('authorization' in prepared)) throw new Error(`QA preview Action refused: ${prepared.phase}/${prepared.requiredFact}${'code' in prepared ? `/${prepared.code}` : ''}`);
  const actionOperationId = randomUUID();
  const body = { ...input, actionOperationId };
  const path = `/v1/deployments/environments/${preview.environmentId}/deploy`;
  const admitted = DeploymentReceiptResultV1Schema.parse(await post(path, body, { 'Content-Type': 'application/json',
    ...createExternalActionAuthorizedRequestHeaders({ authorization: prepared.authorization, effectActionId: 'deployments.deploy', target,
      installationId: installation.installationId, privateKey, method: 'POST', path, body }) }));
  if (!admitted.ok || !('deploymentId' in admitted)) throw new Error(`QA preview receipt refused: ${admitted.ok ? 'pending' : admitted.error}`);
  let receipt = admitted;
  for (const state of ['running', 'succeeded'] as const) {
    const transition: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: preview.environmentId,
      deploymentId: receipt.deploymentId, expectedRevision: receipt.deploymentRevision, actionOperationId,
      machineId, installationId: installation.installationId, kind: state === 'running' ? 'stage' : 'settle', state,
      ...(state === 'succeeded' ? { expectedTargetLinkRevision: preview.targetLinkRevision } : {}) };
    const proof = signMachineInstallationProof({ privateKey, payload: { version: 1, accountId, machineId,
      installationId: installation.installationId, deploymentTransition: { serverId, environmentId: preview.environmentId,
        deploymentId: receipt.deploymentId, actionOperationId, expectedRevision: receipt.deploymentRevision,
        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(transition) } } });
    const next = DeploymentReceiptResultV1Schema.parse(await post(`${path.replace(/\/deploy$/, '')}/deployments/${receipt.deploymentId}/transitions`, { ...transition, proof }));
    if (!next.ok || !('deploymentId' in next)) throw new Error(`QA preview transition refused: ${next.ok ? 'pending' : next.error}`);
    receipt = next;
  }
  // Address admission is a separate record operation against the now-serving runtime link.
  const current = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse((await fetchJson<unknown>(
    `${baseUrl}/v1/deployments/environments/${preview.environmentId}?serverId=${encodeURIComponent(serverId)}`, { headers })).data);
  if (!current.ok) throw new Error(`QA preview address Environment unavailable: ${current.error}`);
  const runtime = current.targetLinks.find(link => link.id === preview.targetLinkId);
  if (!runtime) throw new Error('QA preview address runtime link unavailable');
  const domainPath = `/v1/deployments/environments/${preview.environmentId}/domains`;
  const domain = DeploymentDomainMutationResultV1Schema.parse(await post(domainPath,
    DeploymentDomainAddAdmissionInputV1Schema.parse({ serverId, environmentId: preview.environmentId, domainId: randomUUID(),
      expectedRevision: current.environment.revision, targetLinkId: preview.targetLinkId, expectedTargetLinkRevision: runtime.revision,
      requestKey: randomUUID(), requestId: randomUUID(), actionOperationId: randomUUID(),
      placements: [{ machineId, installationId: installation.installationId, nativeServer: 'records-only-fixture',
        dockerEngineId: 'records-only-fixture', listener: 'public' }],
      ...await artifact(DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, 'Records-only preview address; no DNS or native routing',
        DeploymentDomainContentV1Schema.parse({ hostname: 'preview.records-only.invalid', target: { service: 'app', containerPort: 80 } })) })));
  if (!domain.ok) throw new Error(`QA preview Domain refused: ${domain.error}`);
  // The example address is deliberately unavailable: never claim native routing, DNS or health success.
  const observations = (domain.domain.placements ?? []).map(capture => {
    const observation = { capture, state: 'warning' as const,
      networkExposure: { kind: 'unavailable' as const, reason: 'records_only_fixture' } };
    return { ...observation, proof: signMachineInstallationProof({ privateKey,
      payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: domain.domain.revision, observation }) }) };
  });
  const domainSettled = DeploymentDomainMutationResultV1Schema.parse(await post(`${domainPath}/${domain.domain.id}/transitions`, {
    serverId, environmentId: preview.environmentId, domainId: domain.domain.id,
    expectedDomainRevision: domain.domain.revision, observations,
  }));
  if (!domainSettled.ok) throw new Error(`QA preview Domain observation refused: ${domainSettled.error}`);
  return { artifactsCreated, summary: { serverId, projectId, projectSourceId, productionEnvironmentId: production.environmentId,
    previewEnvironmentId: preview.environmentId, deploymentId: receipt.deploymentId } };
}
