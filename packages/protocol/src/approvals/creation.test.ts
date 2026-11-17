import { projectExternalActionMachineRuntimeDemandV1 } from '../actions/actionSpecs.js';
import { describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import { normalizeActionExecutorThrownError } from '../actions/executor/resultProjection.js';
import { approvalReadFailure } from '../actions/executor/approvalRead.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { ApprovalRequestPublicReadSchema } from './approvalRequestPublicRead.js';
import { buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from './approvalArtifactHeaderV1.js';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema, type ApprovalRequestV2 } from './approvalRequestV1.js';
import { assertApprovalRequestCreationBinding, createApprovalRequestArtifact, deriveApprovalRequestArtifactId } from './creation.js';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from './targetActionApprovalRequestV1.js';
import { settleTargetActionApprovalReplayInputs } from './targetActionApprovalRequestTransition.js';
import { sealExternalActionRequestV2 } from '../actions/externalActionEncryption.js';
import { ExternalActionExecutionAuthorizationV1Schema, projectExternalActionDeploymentNativeEnvelopeAdmissionV1 } from '../actions/externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from '../actions/externalActionExecutionAuthorization.js';
import { isDeploymentChildRootActionIdV1 } from '../deployments/deploymentActionIdsV1.js';

function proposal(value = 'private-value'): ApprovalRequestV2 {
  const actionId = 'identity.providers.secret.replace';
  const input = { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3, clientSecret: value };
  return ApprovalRequestV2Schema.parse({
    v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' },
    requestedSurface: 'ui', summary: 'Replace the provider secret', actionId,
    // Live-only inputs have the same private review projection, but different bindings.
    actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
    requestInputDigest: computeActionInputApprovalDigestV1(actionId, input),
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'home-identity', accountId: 'account', actionId, requestId: 'request' },
  });
}

/** Only the persistence boundary is substituted; it retains Home's exact-id create semantics. */
function persistence() {
  const rows = new Map<string, { header: Record<string, unknown>; body: string; access: string }>();
  let reads = 0;
  let writes = 0;
  const ports = { accountId: 'account',
    newId: () => { throw new Error('V2 must retain request identity'); },
    read: async (artifactId: string) => { reads++; return rows.get(artifactId) ?? null; },
    create: async (artifactId: string, header: Record<string, unknown>, body: string) => {
      if (!rows.has(artifactId)) { rows.set(artifactId, { header, body, access: 'owner' }); writes++; }
    },
  };
  const create = (request: ApprovalRequestV2) => createApprovalRequestArtifact({ ...ports, request });
  const createTarget = (request: TargetActionApprovalRequestV1) => createApprovalRequestArtifact({ ...ports, request });
  return { rows, create, createTarget, counts: () => ({ reads, writes }) };
}

describe('approval Artifact request identity', () => {
  it.each([
    { actionId: 'deployments.domains.add', input: { serverId: 'home', environmentId: 'environment', domainId: 'domain',
      expectedRevision: 3, targetLinkId: 'runtime', expectedTargetLinkRevision: 2, requestKey: 'domain-add',
      contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 } },
    { actionId: 'deployments.restart', input: { serverId: 'home', environmentId: 'environment', deploymentId: 'deployment',
      targetLinkId: 'runtime', machineId: 'controller', installationId: 'installation', expectedGeneration: 'generation',
      service: { kind: 'deployment', machineId: 'controller', environmentId: 'environment', environmentInstanceId: 'instance',
        composeService: 'web', serviceId: 'instance/web' } } },
    { actionId: 'deployments.backups.restore', input: { serverId: 'home', environmentId: 'environment', deploymentId: 'deployment',
      targetLinkId: 'runtime', machineId: 'controller', installationId: 'installation', expectedRevision: 3,
      source: { kind: 'repository', snapshotId: 'backup' }, mode: 'prepare' } },
  ] as const)('creates and rejoins an encrypted $actionId review without losing signed native admission', async ({ actionId, input }) => {
    const home = persistence();
    const target = { kind: 'machine', machineId: 'controller' } as const;
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: 'srv_home', accountId: 'account',
      actionId, requestId: 'native-review', target, authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
      accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'e2ee', serverIdentityId: 'srv_home', machineId: target.machineId,
      installationId: 'installation', actionId, requestId: envelope.requestId, target, environmentId: input.environmentId,
      deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope }),
      ...(isDeploymentChildRootActionIdV1(actionId) ? { deploymentChildRoot: true } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Review native deployment change', actionId, actionArgs: input,
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'srv_home', accountId: 'account', machineId: target.machineId,
        actionId, requestId: envelope.requestId, target, originalActionEnvelope: envelope,
        externalActionExecutionAuthorization: authorization, externalActionInputSignature: 'a'.repeat(86) } });
    const created = await home.create(request);
    expect(created.request).toEqual(request);
    expect(await home.create(request)).toEqual(created);
    expect(home.counts().writes).toBe(1);
    const stored = home.rows.get(created.artifactId)!;
    for (const nativeAdmission of [
      { ...envelope.deploymentNativeAdmission, kind: 'unknown-native-kind' },
      { ...envelope.deploymentNativeAdmission, unrecognizedAuthority: true },
    ]) {
      const changed = { ...request, executionOriginV1: { ...request.executionOriginV1,
        originalActionEnvelope: { ...envelope, deploymentNativeAdmission: nativeAdmission } } };
      home.rows.set(created.artifactId, { ...stored, body: JSON.stringify(changed) });
      await expect(home.create(request)).rejects.toMatchObject({ code: 'approval_invalid' });
    }
    expect(home.counts().writes).toBe(1);
  });

  it('rejoins native optional operands through their persisted JSON representation', async () => {
    const home = persistence();
    const request = { ...proposal(), actionArgs: { id: 'provider-1', optional: undefined } };
    const created = await home.create(request);
    expect(created.request.actionArgs).toEqual({ id: 'provider-1' });
    expect(await home.create(request)).toEqual(created);
    await expect(home.create({ ...request, actionArgs: { id: 'provider-1', optional: null } }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(home.counts().writes).toBe(1);
  });

  it('reports an invalid proposed body with schema issues before writing an unparseable card', async () => {
    const home = persistence();
    const request = { ...proposal(), summary: '' };
    const failure = await home.create(request).catch(normalizeActionExecutorThrownError);
    expect(failure).toMatchObject({ errorCode: 'approval_invalid', details: {
      issues: expect.arrayContaining([expect.objectContaining({ path: ['summary'] })]),
    } });
    expect(home.counts().writes).toBe(0);
    expect(home.rows.size).toBe(0);
  });

  it('carries only the original public identity as an Account-scoped create proof', async () => {
    const request = proposal();
    let scope: unknown;
    let stored: { header: Record<string, unknown>; body: string; access: string } | null = null;
    const result = await createApprovalRequestArtifact({ request, accountId: 'account', newId: () => 'unused',
      read: async () => stored,
      create: async (_id, header, body, idScope?: unknown) => {
        scope = idScope;
        stored = { header, body, access: 'owner' };
        return stored;
      },
    });
    expect(scope).toEqual({ v: 1, sourceId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(result.artifactId[14]).toBe('8');
    expect(JSON.stringify(scope)).not.toContain('private-value');
  });

  it.each([undefined, 'live_only'] as const)('binds contributed Action input to the same request identity without a parallel writer (%s)', async approvalInputCustody => {
    const home = persistence();
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Approve run',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'original' },
      ...(approvalInputCustody ? { approvalInputCustody } : {}),
      sourceCustody: { kind: 'development', registeredRootId: 'root' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64),
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home-identity', accountId: 'account', machineId: 'machine', actionId: 'action.invoke', requestId: 'contributed-request' },
      replayPlacement: { serverId: 'home', machineId: 'machine' },
    });
    const first = await home.createTarget(request);
    expect(await home.createTarget({ ...request, createdAtMs: 2, updatedAtMs: 2 })).toEqual(first);
    expect(await home.createTarget({ ...request,
      executionOriginV1: { ...request.executionOriginV1!, serverId: 'another-home-profile' },
      replayPlacement: { ...request.replayPlacement!, serverId: 'another-home-profile' },
    })).toEqual(first);
    await expect(home.createTarget({ ...request, input: { value: 'changed' }, subjectFingerprint: 'c'.repeat(64) }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(home.counts().writes).toBe(1);
    expect(home.rows.size).toBe(1);
    const unknown = TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'outcome_unknown',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: false,
        effectAttempted: true, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } });
    const receipt = settleTargetActionApprovalReplayInputs(unknown);
    home.rows.set(first.artifactId, { header: buildTargetActionApprovalArtifactHeaderV1(receipt),
      body: JSON.stringify(receipt), access: 'owner' });
    // Transport retry rejoins the old receipt; Request again is a fresh invocation.
    expect((await home.createTarget(request)).request.status).toBe('outcome_unknown');
    // Older 0.3 terminal records can still carry their original review operands.
    home.rows.set(first.artifactId, { header: buildTargetActionApprovalArtifactHeaderV1(unknown),
      body: JSON.stringify(unknown), access: 'owner' });
    expect((await home.createTarget(request)).request.status).toBe('outcome_unknown');
    const again = await home.createTarget({ ...request,
      executionOriginV1: { ...request.executionOriginV1!, requestId: 'fresh-contributed-request' } });
    expect(again.artifactId).not.toBe(first.artifactId);
    expect(again.request).toMatchObject({ status: 'open' });
    expect(again.request.decision).toBeUndefined();
    expect(again.request.execution).toBeUndefined();
    expect(home.rows.size).toBe(2);
  });

  it('creates after a typed existence miss without turning an unavailable read into absence', async () => {
    const request = proposal();
    let written = false;
    const ports = {
      request, accountId: 'account', newId: () => 'unused',
      read: async () => {
        if (!written) throw Object.assign(new Error('not_found'), { code: 'not_found', details: { httpStatus: 404 } });
        return { header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request), access: 'owner' };
      },
      create: async () => { written = true; },
    };
    expect((await createApprovalRequestArtifact(ports)).request).toEqual(request);
    expect(written).toBe(true);
    const refusal = Object.assign(new Error('forbidden'), { code: 'forbidden', status: 403 });
    await expect(createApprovalRequestArtifact({ ...ports,
      read: async () => { throw refusal; }, create: async () => { throw new Error('Must not create after an unavailable read'); },
    })).rejects.toBe(refusal);
  });

  it('rejoins the original pending request after refresh with one exact read and no write', async () => {
    const home = persistence();
    const original = proposal();
    const first = await home.create(original);
    const before = home.counts();
    const replay = await home.create({ ...original, createdAtMs: 10, updatedAtMs: 10, summary: 'Refreshed presentation' });
    expect(replay).toEqual(first);
    expect(home.counts()).toEqual({ reads: before.reads + 1, writes: before.writes });
    expect(home.rows.size).toBe(1);
    // A genuinely new request still reaches the same persistence consumer.
    await home.create({ ...original, executionOriginV1: { ...original.executionOriginV1, requestId: 'another-request' } });
    expect(home.rows.size).toBe(2);
  });

  it('separates a managed root and retained child sharing a requestId, and their exact destinations', async () => {
    const home = persistence();
    const root = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Acquire managed Machine',
      actionId: 'machines.managed.acquire', actionArgs: { homeId: 'home-identity' },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home-identity', accountId: 'account', machineId: 'controller',
        target: { kind: 'machine', machineId: 'controller' }, actionId: 'machines.managed.acquire', requestId: 's0-root-request' },
    });
    const child = ApprovalRequestV2Schema.parse({ ...root, summary: 'Set guest administrator access',
      actionId: 'machines.setup.adminAccess.set', actionArgs: { serverId: 'home-identity', machineId: 'guest' },
      executionOriginV1: { ...root.executionOriginV1, actionId: 'machines.setup.adminAccess.set',
        machineId: 'guest', target: { kind: 'machine', machineId: 'guest' } },
    });
    const first = await home.create(root);
    const second = await home.create(child);
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(home.rows.size).toBe(2);
    expect(await home.create({ ...root, createdAtMs: 2, updatedAtMs: 2 })).toEqual(first);
    expect(await home.create({ ...child, createdAtMs: 2, updatedAtMs: 2 })).toEqual(second);
    const sibling = await home.create({ ...child, actionArgs: { serverId: 'home-identity', machineId: 'other-guest' },
      executionOriginV1: { ...child.executionOriginV1, machineId: 'other-guest', target: { kind: 'machine', machineId: 'other-guest' } } });
    expect(sibling.artifactId).not.toBe(second.artifactId);
    expect(home.rows.size).toBe(3);
    await expect(home.create({ ...child, actionArgs: { changed: true } })).rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(home.rows.size).toBe(3);
  });

  it('binds live-only input and propagates its typed conflict without another write', async () => {
    const home = persistence();
    await home.create(proposal());
    const failure = await home.create(proposal('changed-private-value')).catch(normalizeActionExecutorThrownError);
    expect(failure).toEqual({ errorCode: 'approval_request_conflict', error: 'approval_request_conflict',
      details: { mismatches: ['requestInputDigest'] },
      failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'approval_request_conflict', httpStatus: null } });
    expect(home.counts().writes).toBe(1);
    expect(home.rows.size).toBe(1);
  });

  it('binds caller and original operands independently of presentation', async () => {
    const home = persistence();
    const original = proposal();
    await home.create(original);
    for (const [changed, field] of [
      [{ ...original, actionArgs: { different: true } }, 'actionArgs'],
      [{ ...original, executionOriginV1: { ...original.executionOriginV1, authority: 'account_automation' as const } }, 'executionOriginV1'],
    ] as const) await expect(home.create(changed)).rejects.toMatchObject({ code: 'approval_request_conflict',
      details: { mismatches: [field] } });
    expect(home.counts().writes).toBe(1);
  });

  it('preserves canonical subject mismatch fields when an approval read fails', () => {
    const original = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Read machine vitals',
      actionId: 'machines.vitals.get', actionArgs: { machineId: 'machine' },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home', accountId: 'account', actionId: 'machines.vitals.get', requestId: 'vitals-review' },
    });
    let conflict: unknown;
    try {
      assertApprovalRequestCreationBinding(original, { ...original,
        executionOriginV1: { ...original.executionOriginV1, authority: 'present_user' } });
    } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ code: 'approval_request_conflict' });
    expect(approvalReadFailure(conflict)).toMatchObject({ ok: false, errorCode: 'approval_request_conflict',
      details: { mismatches: ['executionOriginV1'] } });
    const failure = approvalReadFailure(conflict);
    const execution = projectApprovalExecutionFailureV2({ request: original, failure, executedAtMs: 3 });
    const stored = StoredApprovalRequestSchema.parse({ ...original, status: 'failed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution });
    expect(readApprovalExecutionFailure(stored)).toMatchObject({ details: { mismatches: ['executionOriginV1'] } });
    const publicRead = ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(stored));
    expect(publicRead).toMatchObject({ execution: { details: { mismatches: ['executionOriginV1'] } } });
    for (const unsafe of [{ mismatches: ['private-operand'] }, { mismatches: ['actionArgs'], value: 'private-operand' }]) {
      expect(projectApprovalExecutionFailureV2({ request: original, failure: { ...failure, details: unsafe }, executedAtMs: 3 }))
        .not.toHaveProperty('details');
    }
    expect(approvalReadFailure(new Error('Storage is unavailable'))).toEqual({ ok: false,
      errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' });
  });

  it('uses the same persisted winner across simultaneous clients and refuses a changed-input race', async () => {
    const home = persistence();
    const original = proposal();
    const results = await Promise.all([home.create(original), home.create({ ...original, createdAtMs: 2, updatedAtMs: 2 })]);
    expect(results[1]).toEqual(results[0]);
    expect(home.counts().writes).toBe(1);
    const race = persistence();
    const outcomes = await Promise.allSettled([race.create(original), race.create(proposal('other-value'))]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(race.counts().writes).toBe(1);
  });

  it('retains a decision that wins before creation acknowledgement without another approval', async () => {
    const original = proposal();
    const approved = { ...original, status: 'approved' as const, updatedAtMs: 2,
      decision: { kind: 'approve' as const, decidedAtMs: 2 } };
    let stored: { header: Record<string, unknown>; body: string; access: string } | null = null;
    const created = await createApprovalRequestArtifact({ request: original, accountId: 'account', newId: () => 'unused',
      read: async () => stored,
      create: async () => { stored = { header: buildApprovalRequestArtifactHeaderV1(approved), body: JSON.stringify(approved), access: 'owner' }; },
    });
    expect(created.request).toEqual(approved);
  });

  it('does not reopen a settled request or borrow another Account recipient row', async () => {
    const home = persistence();
    const original = proposal();
    const { artifactId } = await home.create(original);
    const canceled = { ...original, status: 'canceled' as const, updatedAtMs: 2 };
    home.rows.set(artifactId, { header: buildApprovalRequestArtifactHeaderV1(canceled), body: JSON.stringify(canceled), access: 'owner' });
    expect((await home.create(original)).request).toEqual(canceled);
    expect(home.counts().writes).toBe(1);
    home.rows.set(artifactId, { header: buildApprovalRequestArtifactHeaderV1(original), body: JSON.stringify(original), access: 'view' });
    await expect(home.create(original)).rejects.toMatchObject({ code: 'approval_invalid' });
    expect(deriveApprovalRequestArtifactId(original, 'another-account')).not.toBe(artifactId);
  });
});
