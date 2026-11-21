import { describe, expect, it } from 'vitest';
import { DeploymentEnvironmentCreateInputV1Schema } from '../deployments/deploymentActionsV1.js';
import { projectActionExecuteFailure } from '../actions/actionExecutionResult.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { ApprovalRequestPublicReadSchema } from './approvalRequestPublicRead.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { projectSettledApprovalExecution } from '../actions/executor/approvalResults.js';

const templateRef = { sourceId: 'apps', itemId: 'database', version: '1',
  ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } };
const templateInput = { mode: 'apply', serverId: 'home', machineId: 'machine', projectSourceId: 'project', templateRef,
  environment: { kind: 'create', name: 'Database', requestKey: 'database', protection: 'nonProduction',
    purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine' },
  target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [] };
const createInput = { mode: 'apply', serverId: 'home', projectSourceId: 'project', requestKey: 'database', name: 'Database',
  definition: { from: 'catalogApp', templateRef }, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' };
const details = { kind: 'partial', phase: 'bindings', environmentId: 'created-environment', revision: 2,
  targetLinkId: 'created-target', errorCode: 'deployment_content_unavailable', savedSecrets: [{ name: 'DATABASE_PASSWORD',
    phase: 'runtime', source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('saved-resource'), resourceRevision: 1 } }],
  unknownSecret: { name: 'DATABASE_ADMIN_PASSWORD', phase: 'runtime', ref: formatSharedSavedSecretRefV1('uncertain-resource') } };
// The template producer has acknowledged Environment, target and secret writes.
const failure = { ok: false as const, effectAttempted: true, errorCode: details.errorCode, error: details.errorCode, details };
function requestFor(actionId: 'deployments.templates.instantiate' | 'deployments.environments.create' | 'settings.get', actionArgs: unknown) {
  return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs, summary: 'Publish catalog App',
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'owner', machineId: 'machine', actionId, requestId: 'publish' } });
}
function storedFailure(request: ReturnType<typeof requestFor>, execution: unknown) {
  return StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
}

describe('catalog App partial failure custody', () => {
  it.each([
    ['deployments.templates.instantiate', templateInput],
    ['deployments.environments.create', createInput],
  ] as const)('retains a producer refusal before effects through %s settlement and public reads', (actionId, input) => {
    const request = ApprovalRequestV2Schema.parse({ ...requestFor(actionId, input), status: 'executing',
      decision: { kind: 'approve', decidedAtMs: 2 } });
    const refused = { ok: false as const, errorCode: 'deployment_content_unavailable',
      error: 'deployment_content_unavailable', effectAttempted: false };
    const settled = projectSettledApprovalExecution({ request, actionId, exec: refused,
      dispatchEffectAttempted: true, executedAtMs: 3 });
    expect(settled.request).toMatchObject({ status: 'failed', execution: { effectAttempted: false } });
    expect(readApprovalExecutionFailure(settled.request)).toEqual(refused);
    expect(projectApprovalRequestForPublicRead(settled.request)).toMatchObject({ execution: { effectAttempted: false } });
  });

  it.each([
    ['deployments.templates.instantiate', templateInput],
    ['deployments.environments.create', createInput],
  ] as const)('retains acknowledged effects and uncertain secret references through %s settlement and public reads', (actionId, input) => {
    const request = requestFor(actionId, input);
    const direct = projectActionExecuteFailure(failure);
    expect(direct).toEqual(failure);
    const execution = projectApprovalExecutionFailureV2({ request, failure: direct, executedAtMs: 3 });
    expect(execution).toMatchObject({ effectAttempted: true, ok: false, details });
    const stored = storedFailure(request, execution);
    expect(readApprovalExecutionFailure(stored)).toEqual(failure);
    const publicRead = ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(stored));
    expect(publicRead).toMatchObject({ status: 'failed', execution: { ok: false, details } });
  });

  it('keeps malformed, unrelated and inconsistent details out of current, stored and public failures', () => {
    const request = requestFor('deployments.templates.instantiate', templateInput);
    const existingInput = { ...templateInput, environment: { kind: 'existing', environmentId: 'existing-environment', expectedRevision: 1 },
      target: { kind: 'existing', targetLinkId: 'existing-target', expectedRevision: 1, installationId: 'installation' },
      destination: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` } };
    const existingRequest = requestFor('deployments.templates.instantiate', existingInput);
    const existingDetails = { ...details, environmentId: 'existing-environment', targetLinkId: 'existing-target' };
    const existingFailure = { ...failure, details: existingDetails };
    expect(projectApprovalExecutionFailureV2({ request: existingRequest, failure: existingFailure, executedAtMs: 3 }))
      .toMatchObject({ details: existingDetails });
    expect(readApprovalExecutionFailure(storedFailure(existingRequest,
      { ...existingFailure, executedAtMs: 3, effectAttempted: true }))).toEqual(existingFailure);
    for (const [invalidRequest, invalidFailure] of [
      [request, { ...failure, details: { ...details, savedSecrets: [{ ...details.savedSecrets[0], source: { kind: 'secret', ref: 'raw-secret' } }] } }],
      [request, { ...failure, errorCode: 'unrelated_error' }],
      [request, { ...failure, details: { ...details, continuation: { actionId: 'deployments.bindings.set',
        input: { serverId: 'other-home', environmentId: 'other-environment', expectedRevision: 1, set: [], remove: [] } } } }],
      [{ ...request, actionArgs: {} }, failure],
      [{ ...request, actionArgs: { ...templateInput, mode: 'preview' } }, failure],
      [existingRequest, { ...failure, details: { ...existingDetails, environmentId: 'other-environment' } }],
      [existingRequest, { ...failure, details: { ...existingDetails, targetLinkId: 'other-target' } }],
      [requestFor('deployments.environments.create', { ...createInput, definition: { from: 'image', image: 'nginx:1', port: 80 } }), failure],
      [requestFor('settings.get', {}), failure],
    ] as const) {
      expect(projectApprovalExecutionFailureV2({ request: invalidRequest, failure: invalidFailure, executedAtMs: 3 }))
        .not.toHaveProperty('details');
      const stored = storedFailure(invalidRequest, { ...invalidFailure, executedAtMs: 3, effectAttempted: true });
      expect(readApprovalExecutionFailure(stored)).not.toHaveProperty('details');
      expect(projectApprovalRequestForPublicRead(stored)).not.toHaveProperty('execution.details');
    }
    const opaque = { ...failure, details: { ...details, token: 'private-fixture' } };
    expect(projectApprovalExecutionFailureV2({ request, failure: opaque, executedAtMs: 3 })).not.toHaveProperty('details');
    const stored = storedFailure(request, { ...opaque, executedAtMs: 3, effectAttempted: true });
    expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details } });
    expect(JSON.stringify(projectApprovalRequestForPublicRead(stored))).not.toContain('private-fixture');
  });
});


const dataContribution = { pluginId: 'com.example.data', localId: 'database' };
const dataPrincipal = { kind: 'account', accountId: 'owner',
  purpose: { consumer: { pluginId: 'com.example.data', localId: 'provision' }, purpose: 'manage' },
  target: { kind: 'account', account: { service: { pluginId: 'com.example.data', localId: 'account' }, accountId: 'selected' } } };
const provision = { action: { pluginId: 'com.example.data', localId: 'provision' },
  input: { name: 'empty-copy', credentialPrincipal: dataPrincipal } };
const copyInput = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', projectSourceId: 'project', requestKey: 'duplicate',
  protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine',
  contentArtifactId: 'private-environment', contentHeaderVersion: 1, contentBodyVersion: 1,
  copyIntentCommitment: 'A'.repeat(43),
  copyFrom: { environmentId: 'source-environment', expectedRevision: 4,
    choices: { secrets: [], values: [], data: [{ targetLinkId: 'source-data', kind: 'createEmpty', provision }] } },
  copyPlan: { bindings: [], data: [{ targetLinkId: 'source-data', targetId: 'database', targetKind: 'database',
    contribution: dataContribution, provision }] } });
const copyDetails = { kind: 'partial', phase: 'target', environmentId: 'copied-environment', revision: 2,
  errorCode: 'deployment_content_unavailable', savedSecrets: [{ name: 'DATABASE_URL', phase: 'runtime',
    source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('new-connection'), resourceRevision: 1 } }],
  requiredFact: 'data:source-data:createEmpty', remedy: 'Open the existing Environment to configure its data.' };
const provisionContinuation = { actionId: 'action.invoke', input: { action: provision.action,
  input: { ...provision.input, serverId: 'home', environmentId: copyDetails.environmentId, expectedRevision: copyDetails.revision } } };
const dataLinkContinuation = { actionId: 'deployments.targets.link', input: { serverId: 'home',
  environmentId: copyDetails.environmentId, expectedRevision: copyDetails.revision, requestKey: 'duplicate-data-source-data',
  targetId: 'database', source: { kind: 'plugin', contribution: dataContribution }, targetKind: 'database', role: 'data', machines: [],
  provider: { credentialPrincipal: dataPrincipal, providerIdentity: { providerAccountId: 'selected', providerResourceId: 'created',
    providerEnvironment: 'new' }, providerEnvironment: { kind: 'native', selection: { branchId: 'new' } } } } };

describe('duplicate managed-data partial failure custody', () => {
  it.each([
    ['provision refusal', { ...copyDetails, continuation: provisionContinuation }],
    ['link refusal', { ...copyDetails, continuation: dataLinkContinuation }],
    ['ambiguous provider effect', copyDetails],
    ['existing allocation recovery', { ...copyDetails, phase: 'environment', savedSecrets: [] }],
  ] as const)('retains %s through current, stored and public approval failures', (_label, partial) => {
    const request = requestFor('deployments.environments.create', copyInput);
    const refused = { ok: false as const, errorCode: partial.errorCode, error: partial.errorCode, details: partial };
    const execution = projectApprovalExecutionFailureV2({ request, failure: refused, executedAtMs: 3 });
    expect(execution).toMatchObject({ details: partial });
    const stored = storedFailure(request, execution);
    expect(readApprovalExecutionFailure(stored)).toMatchObject({ details: partial });
    expect(ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(stored)))
      .toMatchObject({ execution: { details: partial } });
  });

  it('rejects continuations outside the admitted copy data action, destination or credential selection', () => {
    const request = requestFor('deployments.environments.create', copyInput);
    const wrongPrincipal = { ...dataPrincipal, accountId: 'another-owner' };
    for (const partial of [
      { ...copyDetails, continuation: { ...provisionContinuation, input: { ...provisionContinuation.input,
        action: { pluginId: 'com.other.data', localId: 'provision' } } } },
      { ...copyDetails, continuation: { ...provisionContinuation, input: { ...provisionContinuation.input,
        input: { ...provisionContinuation.input.input, name: 'unreviewed' } } } },
      ...[
        { serverId: 'other-home' }, { environmentId: 'other-environment' }, { expectedRevision: 99 },
        { role: 'runtime' }, { targetId: 'other-target' },
        { source: { kind: 'plugin', contribution: { ...dataContribution, pluginId: 'com.other.data' } } },
        { provider: { ...dataLinkContinuation.input.provider, credentialPrincipal: wrongPrincipal } },
      ].map(patch => ({ ...copyDetails, continuation: { ...dataLinkContinuation,
        input: { ...dataLinkContinuation.input, ...patch } } })),
      { ...copyDetails, phase: 'generation' },
      { ...copyDetails, environmentId: undefined },
    ]) {
      const refused = { ok: false as const, errorCode: partial.errorCode, error: partial.errorCode, details: partial };
      expect(projectApprovalExecutionFailureV2({ request, failure: refused, executedAtMs: 3 })).not.toHaveProperty('details');
      const stored = storedFailure(request, { ...refused, executedAtMs: 3 });
      expect(readApprovalExecutionFailure(stored)).not.toHaveProperty('details');
      expect(projectApprovalRequestForPublicRead(stored)).not.toHaveProperty('execution.details');
    }
  });
});
