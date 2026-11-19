import axios from 'axios';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readHomeRequestBody } from './homeRequestBody.testkit';
import * as persistence from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';
import { DeploymentPrepareInputV1Schema, DeploymentEnvironmentCreationReviewV1Schema, DeploymentReceiptListResultV1Schema, DeploymentActionOutputSchemasV1,
    ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol';
import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encryptWithDataKey, encodeBase64 } from '@/api/encryption';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import type { StoredCredentials } from '@/persistence';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { DEPLOYMENT_ACTION_IDS_V1, isDeploymentApprovalMetadataPreparationActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

afterEach(() => { vi.restoreAllMocks(); });

it.each(DEPLOYMENT_ACTION_IDS_V1.filter(actionId => getActionSpec(actionId).sideEffectClass === 'write'
    && getActionSpec(actionId).approvalScope === 'environment'))(
    'resolves the common approval scope for scoped mutation %s', async actionId => {
        const { environment } = createDeploymentEnvironmentDetailV1();
        const signedEffects: string[] = [];
        const metadataOnly = isDeploymentApprovalMetadataPreparationActionIdV1(actionId);
        const http = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: metadataOnly
            ? { ok: true, environment: { id: environment.id, projectSourceId: environment.projectSourceId, purpose: 'standard' } }
            : { ok: true, environment, targetLinks: [] } });
        const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
            resolveRequestHeaders: (_context, effect) => { signedEffects.push(effect); return {}; },
            async dispatchReceipt() { throw new Error('Approval preparation cannot dispatch'); } });
        const input = { serverId: environment.serverId, environmentId: environment.id, projectSourceId: environment.projectSourceId,
            environment: { kind: 'existing', environmentId: environment.id } };
        expect(await deps.resolveEnvironmentApprovalScope!({ actionId, input, context: { serverId: environment.serverId }, phase: 'prepare' }))
            .toEqual({ scope: { kind: 'environment', environmentId: environment.id } });
        expect(signedEffects).toEqual([metadataOnly || actionId === 'deployments.environments.update' || actionId === 'deployments.bindings.set'
            ? actionId : 'deployments.environments.get']);
        expect(http).toHaveBeenCalledTimes(1);
    });

it.each(['operationAcceptance', 'requestId'] as const)('preserves the missing domain %s in the canonical failure cause', async requiredFact => {
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => ({}), async dispatchReceipt() { throw new Error('Missing admission cannot dispatch'); } });
    const result = await deps.deploymentAction!('deployments.domains.remove', {
        serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
        expectedDomainRevision: 1, requestKey: 'request',
    }, requiredFact === 'operationAcceptance' ? {} : { operationAcceptance: { operationId: 'operation', accept() {} } });
    expect(result).toMatchObject({ ok: false, errorCode: 'operation_unavailable', details: { requiredFact },
        failureCause: { errorClass: 'Error', phase: requiredFact === 'operationAcceptance'
            ? 'deployment.domain.operation_acceptance_missing' : 'deployment.domain.request_id_missing' } });
});

it('publishes recovery for failed and unknown receipt-list rows without opening private receipt content', async () => {
    const rows = (['outcome_unknown', 'failed', 'succeeded'] as const).map((state, index) => createDeploymentReceiptHeaderV1({
        id: `receipt-${index}`, state,
    }));
    const http = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, items: rows, nextCursor: null } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({}), dispatchReceipt: async () => { throw new Error('A list cannot dispatch a deployment'); } });
    const result = await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'environment' }, {});
    expect(result).toMatchObject({ ok: true, items: [
        { state: 'outcome_unknown', requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) },
        { state: 'failed', requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) },
        { state: 'succeeded' },
    ] });
    if (!('items' in result)) throw new Error('Expected receipt list');
    expect(result.items[2]).not.toHaveProperty('remedy');
    expect(DeploymentReceiptListResultV1Schema.parse(result)).toEqual(result);
    expect(http).toHaveBeenCalledTimes(1);
});

it.each([
    { state: 'failed', errorCode: 'deployment_failed' },
    { state: 'cancelled', errorCode: 'cancelled' },
    { state: 'outcome_unknown', errorCode: 'outcome_unknown' },
] as const)('retains terminal $state receipt recovery before and after dispatch', async ({ state, errorCode }) => {
    const receipt = { ok: true as const, environmentId: 'environment', revision: 1,
        deploymentId: 'receipt', deploymentRevision: 2, state };
    const http = vi.spyOn(axios, 'request');
    for (const beforeDispatch of [true, false]) {
        http.mockResolvedValue({ status: 200, data: { ...receipt, state: beforeDispatch ? state : 'queued' } });
        const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
            resolveRequestHeaders: () => ({}), dispatchReceipt: async () => receipt });
        const result = await deps.deploymentAction!('deployments.deploy', { serverId: 'home', environmentId: 'environment',
            targetLinkId: 'runtime', expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'request',
            contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 },
        { operationAcceptance: { operationId: 'operation', accept() {} } });
        expect(result).toMatchObject({ ok: false, errorCode, details: { ...receipt,
            requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
    }
});

it('settles a rolled-back deployment request with its missing fact, recovery and transaction cause', async () => {
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 503,
        data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({}),
        dispatchReceipt: async () => { throw new Error('A rolled-back receipt must never dispatch teardown'); } });
    const result = await deps.deploymentAction!('deployments.receipts.list', {
        serverId: 'home', environmentId: 'environment',
    }, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'database_transaction_conflict_exhausted', effectAttempted: false,
        details: { requiredFact: 'transaction_commit', remedy: expect.any(String) },
        failureCause: { phase: 'home.database.transaction', errorCode: 'database_transaction_conflict_exhausted', httpStatus: 503 } });
});

it.each([true, false])('distinguishes a confirmed rollback from an ambiguous deploy timeout (confirmed: %s)', async confirmed => {
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 503, data: {
        error: 'database_transaction_timeout', statusCode: 503,
        ...(confirmed ? { transactionOutcome: 'rolled_back' } : {}),
    } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({}), dispatchReceipt: async () => { throw new Error('No receipt was accepted'); } });
    const result = await deps.deploymentAction!('deployments.deploy', {
        serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime', expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'original-deploy', contentArtifactId: 'candidate',
        contentHeaderVersion: 1, contentBodyVersion: 1,
    }, { operationAcceptance: { operationId: 'operation', accept() {} } });
    expect(result).toMatchObject(confirmed
        ? { ok: false, errorCode: 'database_transaction_timeout', effectAttempted: false,
            details: { requiredFact: 'transaction_commit', transactionOutcome: 'rolled_back' },
            failureCause: { phase: 'home.database.transaction', httpStatus: 503 } }
        : { ok: false, errorCode: 'outcome_unknown' });
});

it('follows an accepted deploy to its settled receipt rather than reporting a lost result', async () => {
    const receipt = { ok: true as const, environmentId: 'environment', revision: 2,
        deploymentId: 'receipt', deploymentRevision: 1, state: 'queued' as const };
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: receipt });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({}), dispatchReceipt: async request => ({ ...request.receipt,
            deploymentRevision: 4, state: 'succeeded' }) });
    await expect(deps.deploymentAction!('deployments.deploy', {
        serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime', expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'original-deploy', contentArtifactId: 'candidate',
        contentHeaderVersion: 1, contentBodyVersion: 1,
    }, { operationAcceptance: { operationId: 'operation', accept() {} } })).resolves.toEqual({
        ...receipt, deploymentRevision: 4, state: 'succeeded',
    });
});

it.each(['bearer', 'signed'] as const)('distinguishes a rejected %s request from a signed-out Home', async kind => {
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 401, data: { error: 'invalid_token' } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: (): Readonly<Record<string, string>> => kind === 'signed' ? { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'signed-root' }
            : { Authorization: 'Bearer account-fixture' },
        dispatchReceipt: async () => { throw new Error('Read cannot dispatch a receipt'); } });
    const result = await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'environment' },
        { surface: 'cli' });
    expect(result).toMatchObject({ ok: false, errorCode: kind === 'signed' ? 'action_forbidden' : 'action_home_signed_out',
        error: kind === 'signed' ? 'action_forbidden (home_signed_authorization_rejected)' : 'action_home_signed_out' });
});

it.each([401, 403])('preserves the closed Home authorization phase on HTTP %s across deployment reads', async status => {
    vi.spyOn(axios, 'request').mockResolvedValue({ status, data: {
        error: status === 401 ? 'invalid_token' : 'credential_scope_denied', authorizationRefusal: 'effect_family',
    } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'never-record-header' }),
        dispatchReceipt: async () => { throw new Error('Read cannot dispatch a receipt'); } });
    const results = [
        await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'environment' }, {}),
        await deps.readEnvironmentAccess({ serverId: 'home', environmentIds: ['environment'] }, {}, 'deployments.receipts.list'),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, errorCode: 'action_forbidden',
        error: 'action_forbidden (home_signed_authorization_rejected:effect_family)',
        failureCause: { phase: 'home.authorization.effect_family', errorClass: 'HttpStatusError', errorCode: 'action_forbidden', httpStatus: status } });
});

it('does not disclose unknown Home refusal metadata or classify bearer authentication as signed execution', async () => {
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 401, data: {
        error: 'invalid_token', authorizationRefusal: 'never-record-untrusted-phase',
    } });
    for (const signed of [true, false]) {
        const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
            resolveRequestHeaders: (): Readonly<Record<string, string>> => signed ? { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'never-record-header' }
                : { Authorization: 'Bearer never-record-header' },
            dispatchReceipt: async () => { throw new Error('Read cannot dispatch a receipt'); } });
        const result = await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'environment' }, {});
        expect(result).toEqual(signed ? { ok: false, errorCode: 'action_forbidden',
            error: 'action_forbidden (home_signed_authorization_rejected)',
            failureCause: { phase: 'home.authorization.signed_request', errorClass: 'HttpStatusError', errorCode: 'action_forbidden', httpStatus: 401 } }
            : { ok: false, errorCode: 'action_home_signed_out', error: 'action_home_signed_out' });
    }
});

it('forwards a public recorded backup id and preserves native restore refusal without code-only dispatch', async () => {
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime', expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'recovery', contentArtifactId: 'candidate', contentHeaderVersion: 1,
        contentBodyVersion: 1, deploymentId: 'retained-code', restoreBackupId: 'd'.repeat(64) };
    const receipt = { ok: true as const, environmentId: 'environment', revision: 2, deploymentId: 'recovery',
        deploymentRevision: 1, state: 'queued' as const };
    const sent: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(new URL(request.url!).pathname).toBe('/v1/deployments/environments/environment/rollback');
        sent.push(request.data);
        return { status: 200, data: receipt };
    });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => ({}), async dispatchReceipt(request) {
            expect(request.input).toEqual(input);
            return { ok: false, errorCode: 'backup_required', error: 'backup_required' };
        } });
    await expect(deps.deploymentAction!('deployments.rollback', input,
        { operationAcceptance: { operationId: 'recovery-operation', accept() {} } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'backup_required' });
    expect(sent).toEqual([{ ...input, actionOperationId: 'recovery-operation' }]);
});

it('identifies a rejected Home read field without retaining its value', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true,
        environment: { ...detail.environment, revision: 'never-record-rejected-value' }, targetLinks: detail.targetLinks } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => ({}), async dispatchReceipt() { throw new Error('Read cannot dispatch'); } });
    const result = await deps.deploymentAction!('deployments.environments.get',
        { serverId: 'home', environmentId: 'environment' }, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output', details: { validation: {
        source: 'deployments.environments.get', httpStatus: 200,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_type', path: ['environment', 'revision'], expected: 'number' })]),
    } } });
    expect(JSON.stringify(result)).not.toContain('never-record-rejected-value');
});

it.each(['response', 'rejection'] as const)('classifies HTTP 431 %s as a transport refusal before parsing deployment output', async kind => {
    const request = vi.spyOn(axios, 'request');
    if (kind === 'response') request.mockResolvedValue({ status: 431, data: { statusCode: 431, error: 'Request Header Fields Too Large' } });
    else request.mockRejectedValue(Object.assign(new Error('never-record-response-value'), {
        response: { status: 431 }, config: { headers: { authorization: 'never-record-header-value' } },
    }));
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => ({}), async dispatchReceipt() { throw new Error('Read cannot dispatch'); } });
    const result = await deps.deploymentAction!('deployments.receipts.get',
        { serverId: 'home', environmentId: 'environment', deploymentId: 'receipt' }, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'request_headers_too_large', details: { httpStatus: 431 } });
    expect(JSON.stringify(result)).not.toContain('never-record');
});

it.each(['plain', 'e2ee'] as const)('keeps %s Duplicate choices out of the Home storage carrier', async mode => {
    const detail = createDeploymentEnvironmentDetailV1();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
        : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const key = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, key.dataKey));
    let contentReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(url).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
        expect(path).toBe('/v1/artifacts/copied-content');
        contentReads++;
        return { status: 200, data: { id: 'copied-content', ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
            encryptionMode: mode, dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
            header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }),
            body: encode({ body: JSON.stringify({ ...detail.content, name: 'Staging', bindings: [] }) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'API_TOKEN',
        source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('private-resource'), resourceRevision: 3 } };
    const input = { serverId: 'home', projectSourceId: 'destination', requestKey: 'copy',
        protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
        controllerMachineId: 'controller', contentArtifactId: 'copied-content', contentHeaderVersion: 1, contentBodyVersion: 1,
        copyIntentCommitment: 'A'.repeat(43),
        copyFrom: { environmentId: 'source-environment', expectedRevision: 7, choices: {
            secrets: [{ binding: { purpose: binding.purpose, phase: binding.phase, name: binding.name }, kind: 'useSameReference' as const }],
            values: [], data: [],
        } }, copyPlan: { bindings: [binding] } };
    const requests = vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://home.test/v1/deployments/environments');
        const { copyFrom: _choices, copyPlan: _plan, ...storage } = input;
        expect(request.data).toEqual({ ...storage,
            copyFrom: { environmentId: input.copyFrom.environmentId, expectedRevision: input.copyFrom.expectedRevision } });
        return { status: 200, data: { ok: true, environmentId: 'staging', revision: 1 } };
    });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
        admitAccount: async () => null, resolveRequestHeaders: async () => ({ Authorization: `Bearer ${credentials.token}` }),
        prepareEnvironment: createPrepareEnvironmentContentForHost({ credentials, serverHttpBaseUrl: 'https://home.test',
            resolveRequestHeaders: async () => ({ Authorization: `Bearer ${credentials.token}` }) }),
        async dispatchReceipt() { throw new Error('Duplicate must not reserve a deployment receipt'); } });
    expect(await deps.deploymentAction!('deployments.environments.create', input, {}))
        .toEqual({ ok: true, environmentId: 'staging', revision: 1 });
    expect(contentReads, 'unreviewed prepared references still enter real content admission').toBe(1);
    contentReads = 0;
    const review = DeploymentEnvironmentCreationReviewV1Schema.parse({ creationDefaults: resolveDeploymentCreationDefaultsV1({
        projectSourceId: input.projectSourceId, projectOwner: { kind: 'account', accountId: 'owner' },
        explicit: { controllerMachineId: input.controllerMachineId }, target: { kind: 'ownServer', machines: [] },
    }) });
    expect(await deps.deploymentAction!('deployments.environments.create', input, {}, review))
        .toEqual({ ok: true, environmentId: 'staging', revision: 1 });
    expect(contentReads, 'reviewed creation must consume its admitted content rather than reopen its own write').toBe(0);
    expect(requests).toHaveBeenCalledTimes(2);
});

it.each(['authorityChanged', 'secret_use_client_required', 'secret_save_client_required'] as const)(
    'preserves %s at the account admission boundary without issuing a deployment request', async code => {
        const requests = vi.spyOn(axios, 'request').mockImplementation(async () => { throw new Error('Admission must precede transport'); });
        const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
            admitAccount: async () => { throw Object.assign(new Error(code), { code }); },
            resolveRequestHeaders: async () => ({}), async dispatchReceipt() { throw new Error('No receipt was reserved'); },
        });
        await expect(deps.deploymentAction!('deployments.environments.get', { serverId: 'home', environmentId: 'environment' }, {}))
            .resolves.toMatchObject({ ok: false, errorCode: code });
        expect(requests).not.toHaveBeenCalled();
    });

it('keeps a custody error after an issued mutation outcome-unknown', async () => {
    const code = 'authorityChanged';
    vi.spyOn(axios, 'request').mockRejectedValue(Object.assign(new Error(code), { code }));
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => ({}), async dispatchReceipt() { throw new Error('No receipt was returned'); } });
    await expect(deps.deploymentAction!('deployments.deploy', { serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime',
        expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate',
        contentHeaderVersion: 1, contentBodyVersion: 1 }, { operationAcceptance: { operationId: 'operation', accept() {} } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
});

it.each(['plain', 'e2ee'] as const)('keeps bindings behind their sole writer at real %s content preparation', async mode => {
    const detail = createDeploymentEnvironmentDetailV1();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
        : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const key = await createResourceDataKey({ credentials, mode });
    const binding = createDeploymentSecretVariableBindingV1({ phase: 'runtime', name: 'TOKEN',
        resourceId: 'resource', resourceRevision: 1 });
    let previous = DeploymentEnvironmentContentV1Schema.parse({ ...detail.content, bindings: [] });
    let candidate = DeploymentEnvironmentContentV1Schema.parse({ ...previous, bindings: [binding] });
    const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, key.dataKey));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
        const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
        return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
            encryptionMode: mode, dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
            header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'App' }),
            body: encode({ body: JSON.stringify(id === 'candidate' ? candidate : previous) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true,
        environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } });
    const prepare = createPrepareEnvironmentContentForHost({ credentials, serverHttpBaseUrl: 'https://home.test',
        resolveRequestHeaders: async () => ({ Authorization: `Bearer ${credentials.token}` }) });
    const content = { contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const update = { serverId: 'home', environmentId: detail.environment.id, expectedRevision: detail.environment.revision, ...content };
    expect.soft(await prepare({ actionId: 'deployments.environments.create', input: { serverId: 'home', projectSourceId: 'source',
        requestKey: 'create', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        controllerMachineId: 'machine', ...content }, context: {} }))
        .toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
    expect.soft(await prepare({ actionId: 'deployments.environments.update', input: update, context: {} }))
        .toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
    previous = candidate;
    candidate = { ...previous, name: 'Renamed' };
    expect(await prepare({ actionId: 'deployments.environments.update', input: update, context: {} })).toBeNull();
    candidate = { ...previous, bindings: [] };
    expect.soft(await prepare({ actionId: 'deployments.environments.update', input: update, context: {} }))
        .toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
});

it('admits the target-only Prepare Environment scope from its authenticated Home read', async () => {
    const { environment } = createDeploymentEnvironmentDetailV1();
    const prepare = DeploymentPrepareInputV1Schema.parse({ projectSourceId: environment.projectSourceId,
        sourceRevision: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
        baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId: environment.serverId, id: 'workspace' },
        sessionRef: { serverId: environment.serverId, sessionId: 'preparation-session' },
        target: { environmentId: environment.id, targetLinkId: 'runtime', expectedTargetLinkRevision: 1 } });
    let current = environment;
    const requests = vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(request.method).toBe('GET');
        expect(request.url).toBe(`https://home.test/v1/deployments/environments/${environment.id}?serverId=${environment.serverId}`);
        return { status: 200, data: { ok: true, environment: current, targetLinks: [] } };
    });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
        admitAccount: async () => null, resolveRequestHeaders: async () => ({ Authorization: 'Bearer fixture-bearer' }),
        async dispatchReceipt() { throw new Error('Prepare policy cannot dispatch deployment effects'); },
    });
    if (!deps.resolveEnvironmentApprovalScope) throw new Error('missing_canonical_scope_resolver');
    const context = { serverId: environment.serverId };
    await expect(deps.resolveEnvironmentApprovalScope({ actionId: 'deployments.prepare', input: prepare,
        context, phase: 'prepare' })).resolves.toEqual({ scope: { kind: 'environment', environmentId: environment.id } });
    current = { ...environment, projectSourceId: 'foreign-source' };
    await expect(deps.resolveEnvironmentApprovalScope({ actionId: 'deployments.prepare', input: prepare,
        context, phase: 'dispatch' })).resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    await expect(deps.resolveEnvironmentApprovalScope({ actionId: 'deployments.prepare', input: { ...prepare, target: undefined },
        context, phase: 'prepare' })).resolves.toEqual({ scope: null });
    expect(requests).toHaveBeenCalledTimes(2);
});

it.each(['deployments.environments.controller.set', 'deployments.restart', 'deployments.cancel'] as const)(
    'retains %s for its content-free approval scope read', async actionId => {
        const { environment } = createDeploymentEnvironmentDetailV1();
        const signedEffects: string[] = [];
        const http = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true,
            environment: { id: environment.id, projectSourceId: environment.projectSourceId,
                purpose: 'preview', previewTemplateEnvironmentId: 'template' } } });
        const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
            admitAccount: async () => null, resolveRequestHeaders: (_context, effect) => {
                signedEffects.push(effect); return { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'signed-root' };
            }, async dispatchReceipt() { throw new Error('Approval preparation cannot dispatch'); } });
        expect(await deps.resolveEnvironmentApprovalScope!({ actionId,
            input: { serverId: environment.serverId, environmentId: environment.id }, context: {}, phase: 'prepare' }))
            .toEqual({ scope: { kind: 'environment', environmentId: environment.id, inheritedEnvironmentId: 'template' } });
        expect(signedEffects).toEqual([actionId]);
        expect(http).toHaveBeenCalledTimes(1);
        expect(http.mock.calls[0]?.[0].url).toBe(`https://home.test/v1/deployments/environments/${environment.id}?serverId=${environment.serverId}&projection=approvalScope`);
    });

it('returns retained pending admission without dispatching or claiming an active receipt', async () => {
    const pending = { ok: true, environmentId: 'environment', revision: 3,
        kind: 'pending', actionOperationId: 'operation' };
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: pending });
    const dispatchReceipt = vi.fn(async () => { throw new Error('Pending admission cannot dispatch native effects'); });
    const update = vi.fn();
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
        admitAccount: async () => null, resolveRequestHeaders: async () => ({}), dispatchReceipt,
    });
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime',
        expectedRevision: 2, expectedTargetLinkRevision: 1, requestKey: 'request',
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1, whenBusy: 'supersede' as const };
    const context = { operationAcceptance: { operationId: 'operation', accept() {} }, operationOwnerUpdate: { update } };
    await expect(deps.deploymentAction!('deployments.deploy', input, context)).resolves.toEqual(pending);
    expect(dispatchReceipt).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
});

it('admits build placement from current private content without publishing replacement content', async () => {
    const { environment, targetLinks, content } = createDeploymentEnvironmentDetailV1();
    const originalRevision = environment.revision;
    let current = environment;
    let issuedMutations = 0;
    const context = { onTransportIssued() { issuedMutations += 1; } };
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const authorizedActions: string[] = [];
    const resolveRequestHeaders = async (_context: unknown, actionId: string) => {
        authorizedActions.push(actionId);
        return { Authorization: `Bearer ${credentials.token}` };
    };
    const bodyReads = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        expect(new URL(url).pathname).toBe(`/v1/artifacts/${environment.contentArtifactId}`);
        return { status: 200, data: { id: environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: environment.contentHeaderVersion, bodyVersion: environment.contentBodyVersion,
            seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const contentWrites = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Placement retains its existing private content'));
    const requests = vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method === 'GET') return { status: 200, data: { ok: true, environment: current,
            targetLinks: targetLinks.map(item => item.targetLink) } };
        expect(request.method).toBe('PATCH');
        expect(request.data).toMatchObject({ patch: { buildMachineId: 'future-builder' } });
        current = { ...current, revision: current.revision + 1 };
        return { status: 200, data: { ok: true, environmentId: environment.id, revision: current.revision } };
    });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
        admitAccount: async () => null, resolveRequestHeaders,
        prepareEnvironment: createPrepareEnvironmentContentForHost({ credentials, serverHttpBaseUrl: 'https://home.test', resolveRequestHeaders }),
        async dispatchReceipt() { throw new Error('A placement edit cannot dispatch a receipt'); },
    });
    await expect(deps.deploymentAction!('deployments.environments.update', {
        serverId: environment.serverId, environmentId: environment.id, expectedRevision: environment.revision,
        contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
        contentBodyVersion: environment.contentBodyVersion, patch: { buildMachineId: 'future-builder' },
    }, context)).resolves.toEqual({ ok: true, environmentId: environment.id, revision: originalRevision + 1 });
    expect(bodyReads).toHaveBeenCalled();
    expect(contentWrites).not.toHaveBeenCalled();
    expect(requests.mock.calls.filter(([request]) => request.method === 'PATCH')).toHaveLength(1);
    expect(issuedMutations, 'metadata preparation cannot claim mutation custody').toBe(1);
    // Supplying new private content alongside the placement edit still needs
    // content admission; placement is not a bypass around a locked definition.
    await expect(deps.deploymentAction!('deployments.environments.update', {
        serverId: environment.serverId, environmentId: environment.id, expectedRevision: current.revision,
        contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
        contentBodyVersion: environment.contentBodyVersion + 1, patch: { buildMachineId: 'future-builder' },
    }, context)).resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
    expect(bodyReads).toHaveBeenCalled();
    expect(requests.mock.calls.filter(([request]) => request.method === 'PATCH')).toHaveLength(1);
    expect(issuedMutations).toBe(1);
    expect(authorizedActions.every(actionId => actionId === 'deployments.environments.update')).toBe(true);
});

it.each(['plain', 'e2ee'] as const)('admits an ingress-only update against its real %s private content', async mode => {
    const detail = createDeploymentEnvironmentDetailV1();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
        : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const key = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, key.dataKey));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
        return { status: 200, data: { id: detail.environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: mode,
            dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
            header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }),
            body: encode({ body: JSON.stringify({ ...detail.content, ingress: undefined }) }),
            headerVersion: detail.environment.contentHeaderVersion, bodyVersion: detail.environment.contentBodyVersion,
            seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const requests = vi.spyOn(axios, 'request').mockImplementation(async request => request.method === 'GET'
        ? { status: 200, data: { ok: true, environment: detail.environment,
            targetLinks: detail.targetLinks.map(item => item.targetLink) } }
        : { status: 200, data: { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 } });
    const privateWrites = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(new URL(url).pathname).toBe('/v1/artifacts');
        const input = ArtifactJsonCreateHttpInputV1Schema.parse(body);
        return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const resolveRequestHeaders = async () => ({ Authorization: `Bearer ${credentials.token}` });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders, prepareEnvironment: createPrepareEnvironmentContentForHost({ credentials,
            serverHttpBaseUrl: 'https://home.test', resolveRequestHeaders }),
        async dispatchReceipt() { throw new Error('An ingress edit cannot dispatch a deployment receipt'); } });
    const updated = await deps.deploymentAction!('deployments.environments.update', { serverId: detail.environment.serverId,
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        contentArtifactId: detail.environment.contentArtifactId, contentHeaderVersion: detail.environment.contentHeaderVersion,
        contentBodyVersion: detail.environment.contentBodyVersion, patch: { ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' } } }, {});
    const acknowledged = DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(updated);
    expect(privateWrites).toHaveBeenCalledTimes(1);
    const writes = requests.mock.calls.filter(([request]) => request.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0].data).toMatchObject({ contentArtifactId: expect.any(String), contentHeaderVersion: 1,
        contentBodyVersion: 1, patch: { ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' } } });
    const written = writes[0]?.[0].data;
    if (!isRecord(written)) throw new Error('Expected one PATCH body');
    expect(written.contentArtifactId).not.toBe(detail.environment.contentArtifactId);
    expect(acknowledged).toMatchObject({ ok: true, revision: detail.environment.revision + 1, preparedArtifact: {
        contentArtifactId: written.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
    } });
});


it('uses the exact Home identity for saved observer access and Environment reads from a local profile', async () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
        await withTempDir('happier-observer-home-', async homeDir => {
            env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
                HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
            reloadConfiguration();
            const serverUrl = 'https://observer-home.test';
            const homeId = 'srv_observer_home';
            const profile = await addServerProfile({ name: 'saved-observer', serverUrl, webappUrl: serverUrl });
            await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
                descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
                    revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
            const detail = createDeploymentEnvironmentDetailV1({ environment:
                { ...createDeploymentEnvironmentDetailV1().environment, serverId: homeId } });
            const requests: string[] = [];
            // Only the Home HTTP boundary is substituted; saved-profile resolution and transport admission stay real.
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const url = new URL(request.url!);
                const selected = request.method === 'POST' ? readHomeRequestBody(request.data).serverId : url.searchParams.get('serverId');
                requests.push(String(selected));
                if (selected !== homeId) return { status: 200, data: { ok: false, error: 'deployment_unavailable' } };
                return { status: 200, data: url.pathname.endsWith('/access')
                    ? { ok: true, items: [{ environmentId: detail.environment.id, read: true, deploy: false }] }
                    : { ok: true, environment: detail.environment, targetLinks: [] } };
            });
            const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: serverUrl, admitAccount: () => null,
                resolveRequestHeaders: () => ({ Authorization: 'Bearer fixture' }),
                dispatchReceipt: async () => { throw new Error('This read cannot dispatch a receipt'); } });
            const context = { surface: 'cli' as const };
            expect(await deps.readEnvironmentAccess({ serverId: profile.id,
                environmentIds: [detail.environment.id] }, context, 'machines.services.detail'))
                .toMatchObject({ ok: true, items: [{ environmentId: detail.environment.id, read: true, deploy: false }] });
            expect(await deps.deploymentAction!('deployments.environments.get',
                { serverId: profile.id, environmentId: detail.environment.id }, context))
                .toMatchObject({ ok: true, environment: { id: detail.environment.id, serverId: homeId } });
            expect(requests).toEqual([homeId, homeId]);
            const profileReads = vi.spyOn(persistence, 'readSettings').mockRejectedValue(new Error('Admitted Home must not re-read profiles'));
            const admitted = { ...context, serverId: profile.id, serverIdentityId: homeId };
            expect(await deps.readEnvironmentAccess({ serverId: homeId, environmentIds: [detail.environment.id] },
                admitted, 'machines.services.detail')).toMatchObject({ ok: true });
            expect(await deps.deploymentAction!('deployments.environments.get',
                { serverId: homeId, environmentId: detail.environment.id }, admitted)).toMatchObject({ ok: true });
            expect(requests).toEqual([homeId, homeId, homeId, homeId]);
            expect(profileReads).not.toHaveBeenCalled();
        });
    } finally { env.restore(); reloadConfiguration(); }
});


it('returns canonical teardown detach without native admission or receipt dispatch', async () => {
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1, targetLinkId: 'runtime',
        expectedTargetLinkRevision: 1, requestKey: 'remove-no-teardown', reason: 'manual' as const, detachKeepRunning: true as const };
    const detached = { ok: true as const, environmentId: 'environment', revision: 2,
        targetLinkId: 'runtime', targetLinkRevision: 2, detached: true };
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(new URL(request.url!).pathname).toBe('/v1/deployments/environments/environment/teardown');
        expect(request.data).toEqual(input);
        return { status: 200, data: detached };
    });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({}),
        admitTeardown: async () => { throw new Error('Plain detach has no native teardown candidate'); },
        dispatchReceipt: async () => { throw new Error('Plain detach must not fabricate a receipt'); } });
    expect(await deps.deploymentAction!('deployments.teardown', input, {})).toEqual(detached);
});

it('types a local contract failure before transport and keeps home_unreachable for a proven Home transport failure', async () => {
    // Live: COR4B-VERCEL-1115 inspect-agent.json — an Environment read without environmentId threw a $ZodError
    // before any request and was reported as home_unreachable ("reconnect to the Home").
    const requests = vi.spyOn(axios, 'request').mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => ({}), async dispatchReceipt() { throw new Error('A read cannot dispatch'); } });
    const contract = await deps.deploymentAction!('deployments.environments.get',
        { serverId: 'home', environmentId: undefined } as unknown as { serverId: string; environmentId: string }, {});
    expect(contract).toMatchObject({ ok: false, errorCode: 'invalid_action_output',
        failureCause: { phase: 'deployment.home.request', errorClass: '$ZodError' } });
    expect(requests).not.toHaveBeenCalled();
    await expect(deps.deploymentAction!('deployments.environments.get', { serverId: 'home', environmentId: 'environment' }, {}))
        .resolves.toMatchObject({ ok: false, errorCode: 'home_unreachable' });
    const access = vi.spyOn(axios, 'request').mockImplementation(async () => { throw new TypeError('local projection failed'); });
    await expect(deps.readEnvironmentAccess({ serverId: 'home', environmentIds: ['environment'] }, {}, 'deployments.environments.get'))
        .resolves.toMatchObject({ ok: false, errorCode: 'home_unreachable' });
    access.mockRestore();
    const headersFailed = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: async () => { throw new TypeError('header projection failed'); },
        async dispatchReceipt() { throw new Error('A read cannot dispatch'); } });
    await expect(headersFailed.readEnvironmentAccess({ serverId: 'home', environmentIds: ['environment'] }, {}, 'deployments.environments.get'))
        .resolves.toMatchObject({ ok: false, errorCode: 'action_failed', failureCause: { phase: 'deployment.home.request', errorClass: 'TypeError' } });
});

it('gives a refused provider dispatch the recovery a person or agent can act on', async () => {
    // Live: COR4B-VERCEL-1115 deploy-agent-1.json returned a bare code with no remedy.
    const receipt = { ok: true as const, environmentId: 'environment', revision: 2,
        deploymentId: 'receipt', deploymentRevision: 1, state: 'queued' as const };
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: receipt });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({}), dispatchReceipt: async () => ({ ok: false, errorCode: 'needsGitAccess', error: 'needsGitAccess' }) });
    await expect(deps.deploymentAction!('deployments.deploy', {
        serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime', expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'original-deploy', contentArtifactId: 'candidate',
        contentHeaderVersion: 1, contentBodyVersion: 1,
    }, { operationAcceptance: { operationId: 'operation', accept() {} } })).resolves.toMatchObject({ ok: false,
        errorCode: 'needsGitAccess', details: { requiredFact: 'deploymentActionResult',
            remedy: expect.stringContaining('access to the repository') } });
});
