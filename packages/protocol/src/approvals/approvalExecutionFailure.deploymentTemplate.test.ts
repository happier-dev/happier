import { describe, expect, it } from 'vitest';
import { projectActionExecuteFailure } from '../actions/actionExecutionResult.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { ApprovalRequestPublicReadSchema } from './approvalRequestPublicRead.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';

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
const failure = { ok: false as const, errorCode: details.errorCode, error: details.errorCode, details };
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
