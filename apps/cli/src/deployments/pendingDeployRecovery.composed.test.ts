import { expect, it, vi } from 'vitest';
import type { ActionExecutorContext, DeploymentPendingDeployV1 } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createActionOperationCancellationFixture } from '@/daemon/actionOperations/actionOperationCancellation.testkit';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { DeploymentDeployAdmissionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { readReviewedDeploymentDeployInput } from '@/api/externalActionExecutionAuthorization';

// Fresh requester custody, resource codecs and host runner stay real. Only the
// Home HTTP boundary is substituted; the retained row is a previous admission.
it.each([
    { mode: 'plain', changed: 'none' }, { mode: 'e2ee', changed: 'none' },
    { mode: 'e2ee', changed: 'requester' }, { mode: 'e2ee', changed: 'Home' },
    { mode: 'e2ee', changed: 'installation' }, { mode: 'e2ee', changed: 'cipher' },
    { mode: 'e2ee', changed: 'legacy' },
    { mode: 'e2ee', changed: 'inner operation' }, { mode: 'e2ee', changed: 'candidate source' },
    { mode: 'e2ee', changed: 'source method' }, { mode: 'e2ee', changed: 'target link' },
    { mode: 'e2ee', changed: 'stale Environment' }, { mode: 'e2ee', changed: 'stale link' },
    { mode: 'e2ee', changed: 'changed runtime' }, { mode: 'e2ee', changed: 'retained link advance' },
    { mode: 'e2ee', changed: 'admission revision ahead' },
    { mode: 'e2ee', changed: 'malformed intent' },
    { mode: 'plain', changed: 'compact retry' }, { mode: 'e2ee', changed: 'compact retry' },
] as const)('fresh ordinary Deploy re-admits only its retained correspondence ($mode/$changed)', async ({ mode, changed }) => {
    const detail = createDeploymentEnvironmentDetailV1();
    const candidate = createDeploymentReceiptDetailV1();
    const serverId = 'srv_pending_recovery';
    const machineId = 'machine-a';
    const accountId = 'custodian';
    const operationId = 'retained-operation';
    const environment = { ...detail.environment, serverId, controllerMachineId: machineId,
        owner: { kind: 'account' as const, accountId } };
    const link = detail.targetLinks[0].targetLink;
    const resourceKey = new Uint8Array(32).fill(31);
    const intent = { sourceIntent: candidate.content.sourceIntent, requestKey: 'captured-request',
        actionOperationId: operationId, targetLinkId: link.id };
    const protectedIntent = changed === 'inner operation' ? { ...intent, actionOperationId: 'unrelated-operation' }
        : changed === 'source method' ? { ...intent, sourceMethod: 'gitIntegration' as const }
            : changed === 'target link' ? { ...intent, targetLinkId: 'other-link' } : intent;
    const pendingDeploy: DeploymentPendingDeployV1 = mode === 'plain' ? { t: 'plain', v: protectedIntent }
        : { t: 'encrypted', c: encodeBase64(encryptWithDataKey(changed === 'malformed intent'
            ? { ...intent, sourceMethod: { untrusted: 'not-a-method' } } : protectedIntent, resourceKey)) };
    const candidateContent = changed === 'candidate source' ? { ...candidate.content,
        sourceIntent: candidate.content.sourceIntent.kind === 'repository'
            ? { ...candidate.content.sourceIntent, sha: 'e'.repeat(40) }
            : { ...candidate.content.sourceIntent, document: `${candidate.content.sourceIntent.document}\n# changed` } } : candidate.content;
    const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision + Number(changed === 'retained link advance'), requestKey: intent.requestKey,
        contentArtifactId: 'fresh-reviewed-candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
        whenBusy: 'supersede' as const, pendingDeploy };
    const compactInput = { serverId, environmentId: environment.id, targetLinkId: link.id,
        requestKey: input.requestKey, whenBusy: 'supersede' as const };
    const { pendingDeploy: _alreadyProtected, ...newPreparedInput } = input;
    const operationInput = changed === 'compact retry' ? newPreparedInput : input;
    const runningReceipt = { ...candidate.deployment, state: 'running' as const,
        contentArtifactId: input.contentArtifactId };
    let dataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER;
    let installationId = '';
    let hasPending = changed !== 'compact retry';
    // The server's pending SET advances both the row and captured admission;
    // the retained runner input still carries its original pre-SET revision.
    let currentRevision = input.expectedRevision + Number(hasPending);
    let currentPendingDeploy = pendingDeploy;
    let currentRequesterAccountId = accountId;
    let reads = 0;
    let receiptReads = 0;
    const writes: unknown[] = [];
    const candidatePublications: unknown[] = [];
    const unmatchedHttp = new Map<string, number>();
    const encode = (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, resourceKey));
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, resolveAction: () => null });
    const fixture = await createActionOperationCancellationFixture({ mode, accountId, actionId: 'deployments.deploy', admittedMachineRole: 'manage',
        actionInput: changed === 'compact retry' ? compactInput : input,
        deploymentCandidateSource: { id: environment.projectSourceId, revision: 1 },
        address: { serverId, machineId, operationId }, store, runner,
        async requestHttp(request) {
            const path = new URL(request.url).pathname;
            if (request.method === 'GET' && path.startsWith('/v1/artifacts/')) {
                const isEnvironment = path.endsWith(`/${environment.contentArtifactId}`);
                const isTargetLink = path.endsWith(`/${link.contentArtifactId}`);
                return { status: 200, data: { id: isEnvironment ? environment.contentArtifactId
                    : isTargetLink ? link.contentArtifactId : input.contentArtifactId,
                    ownerAccountId: accountId, access: 'view', publicAudience: 'none', encryptionMode: mode,
                    dataEncryptionKey, header: encode({ kind: isEnvironment ? 'deployment-environment.v1'
                        : isTargetLink ? 'deployment-target-link.v1' : 'deployment-receipt.v1', title: 'Fixture' }),
                    body: encode({ body: JSON.stringify(isEnvironment ? detail.content
                        : isTargetLink ? detail.targetLinks[0].content : candidateContent) }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
            }
            if (request.method === 'GET' && path === `/v1/deployments/environments/${environment.id}`) {
                reads += 1;
                return { status: 200, data: { ok: true, environment: { ...environment,
                    revision: currentRevision + Number(changed === 'stale Environment'),
                    ...(changed === 'changed runtime' ? { runtimeTargetLinkId: 'replacement-link' } : {}) },
                    targetLinks: detail.targetLinks.map(item => ({ ...item.targetLink,
                        members: item.targetLink.members.map(member => ({ ...member,
                            ...(member.machineId === machineId ? { installationId } : {}) })),
                        revision: item.targetLink.revision + Number(changed === 'stale link' || changed === 'retained link advance') })),
                    ...(hasPending ? { pendingDeploy: changed === 'cipher' && pendingDeploy.t === 'encrypted'
                        ? { ...pendingDeploy, c: encodeBase64(encryptWithDataKey({ ...intent, actionOperationId: 'replacement-operation' }, resourceKey)) }
                        : currentPendingDeploy,
                    ...(changed === 'legacy' ? {} : { pendingAdmission: {
                        requesterAccountId: changed === 'requester' ? 'other-account' : currentRequesterAccountId,
                        serverId: changed === 'Home' ? 'srv_other_home' : serverId, requestKey: input.requestKey,
                        actionOperationId: operationId, controller: { machineId,
                            installationId: changed === 'installation' ? 'other-installation' : installationId },
                        environmentRevision: currentRevision + Number(changed === 'admission revision ahead') } }) } : {}) } };
            }
            if (request.method === 'GET' && path.endsWith('/deployments')) {
                receiptReads += 1;
                return { status: 200, data: { ok: true, items: [runningReceipt], nextCursor: null } };
            }
            if (request.method === 'GET' && path === `/v1/deployments/receipts/${runningReceipt.id}`) {
                return { status: 200, data: { ok: true, deployment: runningReceipt } };
            }
            if (request.method === 'POST' && path.endsWith('/deploy')) {
                writes.push(request.body);
                if (changed === 'stale Environment' || changed === 'stale link') {
                    return { status: 409, data: { ok: false, error: 'deployment_conflict' } };
                }
                if (changed === 'compact retry' && !hasPending) {
                    // First admission performs the actual pending SET CAS.
                    // Its runner input remains the original pre-CAS identity.
                    hasPending = true;
                    currentRevision += 1;
                    const captured = DeploymentDeployAdmissionInputV1Schema.parse(request.body).pendingDeploy;
                    if (!captured) throw new Error('Expected host-authored protected pending intent');
                    currentPendingDeploy = captured;
                }
                return { status: 200, data: { ok: true, environmentId: environment.id, revision: currentRevision,
                    kind: 'pending', actionOperationId: operationId } };
            }
            if (request.method === 'POST' && path === '/v1/artifacts') {
                candidatePublications.push(request.body);
                return { status: 403, data: { error: 'Forbidden' } };
            }
            // Only method/path/count from this fixed-ID test Home boundary;
            // never headers, queries, request bodies, or exception messages.
            const key = `${request.method} ${path}`;
            unmatchedHttp.set(key, (unmatchedHttp.get(key) ?? 0) + 1);
            return undefined;
        },
    });
    installationId = fixture.installation.installationId;
    if (mode === 'e2ee') {
        if (fixture.credentials.encryption?.type !== 'dataKey') throw new Error('Expected requester encryption material');
        dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
            recipientPublicKey: fixture.credentials.encryption.publicKey, randomBytes: length => new Uint8Array(length).fill(17) }));
    }
    const fresh = await fixture.prepareRoot();
    expect(fresh, JSON.stringify(fixture.diagnostics)).not.toBeNull();
    if (!fresh) throw new Error('Fresh requester admission unavailable');
    const requester = readRequesterAccountActionContext(fresh.authorization);
    if (!requester) throw new Error('Fresh requester custody unavailable');
    const runtime = createHostActionOperationRuntime({ serverId, machineId, resolveAccountId: async () => accountId,
        custodyBinding: { serverId, installationId },
        generateOperationId: () => changed === 'compact retry' ? operationId : 'different-new-operation' });
    const native = vi.fn(async () => { throw new Error('Pending recovery cannot acquire native custody'); });
    // Before the producer lands, the optional port is absent and the old host
    // ignores it. Afterwards this is the real runtime method, never a stub.
    const observation = 'preparePendingDeploymentObservation' in runtime
        && typeof runtime.preparePendingDeploymentObservation === 'function'
        ? runtime.preparePendingDeploymentObservation : undefined;
    const deploymentHost = { credentials: requester.credentials, serverId,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
        serverHttpBaseUrl: 'https://cancel-home.invalid', machineId,
        runtime: { acquire: native }, preparePendingDeploymentObservation: observation };
    const deps = createDaemonDeploymentActionDeps(deploymentHost);
    const context: ActionExecutorContext = { authority: 'present_user', actionCaller: { kind: 'ui' }, serverId,
        externalActionExecutionAuthorization: fresh.authorization, originalActionEnvelope: fixture.envelope };
    const reviewed = await readReviewedDeploymentDeployInput({ authorization: fresh.authorization, envelope: fixture.envelope });
    expect(reviewed, 'the original signed deploy input must open before recovery').not.toBeNull();
    let retryCustody: typeof fresh | undefined;
    try {
        // Reading correspondence is diagnostic, not execution or operation creation.
        const metadata = await deps.deploymentAction('deployments.environments.get', { serverId, environmentId: environment.id }, context);
        expect(metadata).toMatchObject({ ok: true });
        if (changed !== 'legacy' && changed !== 'compact retry') expect(metadata).toMatchObject({ pendingAdmission: { actionOperationId: operationId } });
        expect(runtime.store.list({ accountId, machineId }).items).toEqual([]);
        expect(writes).toEqual([]);
        const request = { actionId: 'deployments.deploy' as const, input: operationInput, context,
            recoverPendingDeployment: () => deps.readPendingDeploymentRecovery(operationInput, context),
            execute: async (operation: ActionExecutorContext) => {
                const result = await deps.deploymentAction('deployments.deploy', operationInput, operation);
                return 'errorCode' in result ? result : { ok: true as const, result };
            } };
        if (changed === 'none' || changed === 'retained link advance' || changed === 'compact retry' || changed === 'admission revision ahead') {
            expect(await runtime.runActionOperation(request)).toMatchObject({ ok: true,
                result: { kind: 'pending', actionOperationId: operationId, operation: { serverId, machineId, operationId } } });
            expect(runtime.store.get({ accountId, machineId }, operationId)).toMatchObject({ state: 'running' });
            expect(runtime.store.get({ accountId, machineId }, 'different-new-operation')).toBeNull();
            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatchObject({ actionOperationId: operationId, pendingDeploy: currentPendingDeploy, requestKey: intent.requestKey });
            await vi.waitFor(() => expect(receiptReads).toBe(1));
            const readsBeforeReplay = reads;
            const firstProjection = runtime.store.get({ accountId, machineId }, operationId);
            expect(await runtime.runActionOperation(request)).toMatchObject({ ok: true,
                result: { kind: 'pending', actionOperationId: operationId } });
            expect(runtime.store.get({ accountId, machineId }, operationId)).toBe(firstProjection);
            expect(reads).toBe(readsBeforeReplay);
            expect(writes).toHaveLength(1);
            if (changed === 'compact retry') {
                // A fresh explicit compact Deploy observes the already admitted
                // invocation before candidate authoring, through the public
                // executor and its real current-resource/approval policy.
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                    serverId, machineId,
                    runActionOperation: operation => runtime.runActionOperation({ ...operation,
                        recoverPendingDeployment: () => deps.readPendingDeploymentRecovery(operation.input, operation.context) }),
                });
                const unconfirmed = await executor.execute('deployments.deploy', compactInput, { ...context, surface: 'ui',
                    actionsSettings: requester.accountSettingsContext.settings.actionsSettingsV1 });
                expect(unconfirmed).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
                expect(runtime.store.get({ accountId, machineId }, operationId)).toBe(firstProjection);
                expect(writes).toHaveLength(1);
                expect(candidatePublications).toEqual([]);
                expect(native).not.toHaveBeenCalled();
                // The requester deliberately allows this exact Action through
                // ordinary Account policy. Read/decrypt that changed Settings
                // at fresh canonical custody admission, not a decision mock or
                // a host-confirmation stamp on an external signed root.
                fixture.setAccountSettings({ actionsSettingsV1: setActionApprovalOverride({
                    settings: normalizeActionsSettingsV1(null), actionId: 'deployments.deploy', surface: 'ui', approvalRequired: false,
                }) });
                retryCustody = await fixture.prepareRoot() ?? undefined;
                expect(retryCustody, JSON.stringify(fixture.diagnostics)).toBeDefined();
                if (!retryCustody) throw new Error('Fresh requester policy admission unavailable');
                const retryRequester = readRequesterAccountActionContext(retryCustody.authorization);
                if (!retryRequester) throw new Error('Fresh requester policy custody unavailable');
                const retryContext: ActionExecutorContext = { ...context, surface: 'ui',
                    externalActionExecutionAuthorization: retryCustody.authorization,
                    actionsSettings: retryRequester.accountSettingsContext.settings.actionsSettingsV1 };
                const retried = await executor.execute('deployments.deploy', compactInput, retryContext);
                const diagnostic = JSON.stringify({ ok: retried.ok,
                    ...(!retried.ok ? { errorCode: retried.errorCode } : {}),
                    candidatePublications: candidatePublications.length, nativeCalls: native.mock.calls.length,
                    unmatchedHttp: [...unmatchedHttp] });
                expect(retried, diagnostic).toMatchObject({ ok: true,
                    result: { kind: 'pending', actionOperationId: operationId,
                        operation: { serverId, machineId, operationId } } });
                expect(runtime.store.get({ accountId, machineId }, operationId)).toBe(firstProjection);
                expect(writes).toHaveLength(1);
                expect(candidatePublications).toEqual([]);
                expect(native).not.toHaveBeenCalled();
                expect(await executor.execute('deployments.deploy', { ...compactInput, sha: 'e'.repeat(40) },
                    retryContext)).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
                const acceptedCipher = currentPendingDeploy;
                const changedMethod = { ...intent, sourceMethod: 'upload' as const };
                currentPendingDeploy = mode === 'plain' ? { t: 'plain', v: changedMethod }
                    : { t: 'encrypted', c: encodeBase64(encryptWithDataKey(changedMethod, resourceKey)) };
                expect(await executor.execute('deployments.deploy', compactInput,
                    retryContext)).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
                currentPendingDeploy = acceptedCipher;
                currentRequesterAccountId = 'another-requester';
                expect(await executor.execute('deployments.deploy', compactInput,
                    retryContext)).toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
                currentRequesterAccountId = accountId;
                const preparedObservation = await executor.prepare('deployments.deploy', compactInput,
                    retryContext);
                expect(preparedObservation.kind).toBe('ready');
                if (preparedObservation.kind !== 'ready') throw new Error('Expected a deferred authorized observation');
                fixture.setCurrent(false);
                // The existing admitted observation finishes; withdrawal is
                // enforced when the next requester custody is acquired.
                expect(await preparedObservation.invocation.run()).toMatchObject({ ok: true,
                    result: { kind: 'pending', actionOperationId: operationId } });
                expect(await fixture.prepareRoot()).toBeNull();
                expect(runtime.store.get({ accountId, machineId }, operationId)).toBe(firstProjection);
                expect(currentPendingDeploy).toBe(acceptedCipher);
                expect(writes).toHaveLength(1);
                expect(candidatePublications).toEqual([]);
                expect(native).not.toHaveBeenCalled();
            }
        } else if (changed === 'stale Environment' || changed === 'stale link') {
            // This direct runner callback exposes the storage result; the
            // server, rather than cold observation, owns this revision CAS.
            expect(await runtime.runActionOperation(request)).toMatchObject({ ok: true,
                result: { ok: false, error: 'deployment_conflict' } });
            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatchObject({ expectedRevision: input.expectedRevision,
                expectedTargetLinkRevision: input.expectedTargetLinkRevision, pendingDeploy: currentPendingDeploy });
        } else {
            const code = changed === 'malformed intent' ? 'deployment_content_unavailable' : changed === 'legacy' ? 'operation_unavailable'
                : ['cipher', 'inner operation', 'candidate source', 'source method', 'target link', 'stale Environment', 'stale link', 'changed runtime'].includes(changed)
                    ? 'deployment_conflict' : 'deployment_access_denied';
            await expect(runtime.runActionOperation(request)).rejects.toMatchObject({ rpcErrorCode: code });
            expect(runtime.store.list({ accountId, machineId }).items).toEqual([]);
            expect(writes).toEqual([]);
        }
        expect(reads).toBeGreaterThan(0);
        expect(native).not.toHaveBeenCalled();
    } finally {
        // Restore only the substituted Home boundary after refusal assertions;
        // test-owned runner disposal must not inherit a withdrawn credential.
        fixture.setCurrent(true);
        runtime.runner.cancel({ accountId, machineId }, operationId);
        runtime.runner.cancel({ accountId, machineId }, 'different-new-operation');
        await runtime.runner.waitForTerminal({ accountId, machineId }, operationId);
        await runtime.runner.waitForTerminal({ accountId, machineId }, 'different-new-operation');
        await retryCustody?.dispose();
        await fresh.dispose();
    }
});
