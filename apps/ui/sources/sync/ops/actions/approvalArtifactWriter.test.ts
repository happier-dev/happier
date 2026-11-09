import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    ArtifactJsonCreateHttpInputV1Schema,
    artifactIdScopeMatchesAccountV1,
    buildApprovalRequestArtifactHeaderV1,
    decodePlainArtifactStoredContent,
    encodePlainArtifactStoredContent,
    type ApprovalRequest,
    type ApprovalRequestV2,
} from '@happier-dev/protocol';

import type { ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerFetch } from '@/sync/http/client';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

// Only the Account server's HTTP boundary is
// replaced. The Home's Artifact routes are the testkit's stateful store with
// the Home's versioned compare-and-set; the real Artifact API adapter and
// codec, the real CAS writer (`updateArtifactWithHeaderViaApi`) and the real
// Protocol approval subject/transition owner all run above it.
const home = { artifacts: createArtifactStoreBoundary({ ownerAccountId: () => 'account-1', encryptionMode: 'plain' }) };
const request: ServerFetch = async (path, init) => {
    if (path === '/v1/artifacts' && init?.method === 'POST') {
        const wire = ArtifactJsonCreateHttpInputV1Schema.parse(JSON.parse(String(init.body)));
        // Mirror the genuine Home boundary with its canonical admission owner.
        // Dropping the scope at any UI adapter must refuse this creation.
        if (!artifactIdScopeMatchesAccountV1({ artifactId: wire.id, accountId: 'account-1', idScope: wire.idScope }))
            return Response.json({ error: 'Invalid parameters' }, { status: 400 });
    }
    return path === '/v1/account/encryption' ? Response.json({ mode: 'plain', updatedAt: 1 })
        : path === '/v1/account/encryption/currentness' ? Response.json(createPlainAccountEncryptionCurrentnessFixture())
        : await home.artifacts.handle(path, init) ?? Response.json({ error: 'not_found' }, { status: 404 });
};

import { createArtifactWithHeaderViaApi, fetchArtifactWithBodyFromApi, updateArtifactWithHeaderViaApi } from '@/sync/engine/artifacts/syncArtifacts';
import { createApprovalArtifact, writeApprovalRequestArtifact } from './approvalArtifactWriter';
import { approvalArtifactBodyMatchesHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ApprovalRequestSchema, StoredApprovalRequestSchema, ApprovalRequestV1Schema, ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createApprovalRequestArtifact, deriveApprovalRequestArtifactId, settleApprovalRequestReplayInputs } from '@happier-dev/protocol/approvals/approvalRequestTransition';

const ARTIFACT_ID = 'approval-1';
const CLIENT_SECRET = 'synthetic-provider-client-secret';

function openRequest(): ApprovalRequestV2 {
    return {
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        requestedSurface: 'ui',
        executionOriginV1: {
            v: 1,
            authority: 'present_user',
            surface: 'ui',
            caller: { kind: 'host' },
            serverId: 'home-1',
            accountId: 'account-1',
            actionId: 'identity.providers.secret.replace',
            requestId: 'request-1',
        },
        actionId: 'identity.providers.secret.replace',
        actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3, clientSecret: CLIENT_SECRET },
        summary: 'Replace the provider secret',
    };
}

/** Creates the approval Artifact through the Home's own create route. */
async function seed(request: ApprovalRequest | TargetActionApprovalRequestV1, header?: ArtifactHeader, artifactId = ARTIFACT_ID): Promise<void> {
    const target = TargetActionApprovalRequestV1Schema.safeParse(request);
    const artifactHeader = header ?? (target.success
        ? buildTargetActionApprovalArtifactHeaderV1(target.data)
        : buildApprovalRequestArtifactHeaderV1(ApprovalRequestSchema.parse(request)));
    const created = await home.artifacts.handle('/v1/artifacts', {
        method: 'POST',
        body: JSON.stringify({
            id: artifactId,
            header: encodePlainArtifactStoredContent(artifactHeader),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
    });
    expect(created?.status).toBe(200);
}

/** The decoded request body the Home keeps — what a privacy assertion must inspect. */
function storedJson(): string {
    const body = home.artifacts.readPlainBody(ARTIFACT_ID);
    if (body === null) throw new Error('approval_artifact_missing');
    return body;
}

function stored(): ApprovalRequestV2 {
    return JSON.parse(storedJson());
}

const params = { credentials: { token: createAccountTokenForTests('account-1') }, request,
    encryption: null, artifactDataKeys: new Map() } as const;

/** One UI creator using the real Artifact API, codec and Protocol creation owner. */
function uiCreator() {
    return (request: ApprovalRequestV2) => createApprovalArtifact({ request, accountId: 'account-1',
        read: artifactId => fetchArtifactWithBodyFromApi({ ...params, artifactId, fresh: true, ownerOnly: true }),
        create: async (artifactId, header, body, idScope) => {
            const publication: { artifact?: DecryptedArtifact } = {};
            await createArtifactWithHeaderViaApi({ ...params, artifactId, header, body, idScope,
                addArtifact: artifact => { publication.artifact = artifact; } });
            if (!publication.artifact) throw new Error('Missing acknowledged Artifact');
            return publication.artifact;
        },
    });
}

/** One UI client: the real read and the real CAS writer against the validated read. */
function uiWriter(acquired?: DecryptedArtifact) {
    return async (request: ApprovalRequest | TargetActionApprovalRequestV1, expectedStatus?: ApprovalRequest['status']) => await writeApprovalRequestArtifact({
        artifactId: ARTIFACT_ID,
        request,
        expectedStatus,
        read: async (artifactId) => acquired ?? await fetchArtifactWithBodyFromApi({ ...params, artifactId }),
        write: async (basis: DecryptedArtifact, header: ArtifactHeader, body: string) => {
            await updateArtifactWithHeaderViaApi({
                ...params, artifactId: ARTIFACT_ID, header, body,
                getArtifact: () => basis,
                updateArtifact: () => {},
            });
        },
    });
}

const approve = (request: ApprovalRequestV2): ApprovalRequestV2 => ({
    ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
});
const claim = (request: ApprovalRequestV2): ApprovalRequestV2 => ({ ...request, status: 'executing', updatedAtMs: 3 });

describe('UI approval Artifact writer', () => {
    beforeEach(() => {
        home.artifacts.clear();
    });

    it('cancels retained Publish history through the stored transition owner without changing its private subject', async () => {
        const current = openRequest();
        const history = StoredApprovalRequestSchema.parse({
            ...current,
            actionId: 'deployments.publish',
            actionArgs: { privateHistoricalInput: 'retained-input' },
            executionOriginV1: {
                ...current.executionOriginV1,
                actionId: 'deployments.publish',
                externalActionExecutionAuthorization: {
                    token: 'retained-private-proof',
                    deploymentPreparationAdmission: { operation: 'publish' },
                },
                originalActionEnvelope: { actionId: 'deployments.publish', input: { oldPrivateInput: true } },
            },
        });
        await seed(history, buildApprovalRequestArtifactHeaderV1(history));
        await expect(uiWriter()({ ...history, status: 'canceled', updatedAtMs: 2,
            actionArgs: { privateHistoricalInput: 'changed-input' } }, 'open'))
            .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        expect(JSON.parse(storedJson())).toEqual(history);

        const canceled = { ...history, status: 'canceled' as const, updatedAtMs: 2 };
        await expect(uiWriter()(canceled, 'open')).resolves.toEqual({ ok: true });
        expect(JSON.parse(storedJson())).toEqual(canceled);
    });

    it('creates one pending request across independent UI writers and rejects changed input', async () => {
        const create = uiCreator();
        const open = openRequest();
        const created = await create(open);
        const repeated = await create({ ...open, createdAtMs: 2, updatedAtMs: 2 });
        expect(repeated).toEqual(created);
        await expect(create({ ...open, actionArgs: { ...open.actionArgs as object, clientSecret: 'changed-secret' } }))
            .rejects.toMatchObject({ code: 'approval_request_conflict' });
        expect(home.artifacts.list()).toHaveLength(1);
        expect(home.artifacts.readPlainBody(created.artifactId)).toBe(JSON.stringify(open));
    });

    it('keeps a retained child and other destinations distinct while rejoining each exact request', async () => {
        const create = uiCreator();
        // These opaque private review operands exercise approval storage only;
        // no Machine Action effect or its native input admission runs here.
        const machineRequest = (actionId: ApprovalRequestV2['actionId'], machineId: string): ApprovalRequestV2 =>
            ApprovalRequestV2Schema.parse({
                ...openRequest(),
                actionId,
                actionArgs: { machineId, review: { kind: 'private-machine-operation' } },
                executionOriginV1: {
                    ...openRequest().executionOriginV1,
                    actionId,
                    requestId: 'managed-root-request',
                    machineId,
                    target: { kind: 'machine', machineId },
                },
            });
        const root = machineRequest('machines.managed.acquire', 'controller-machine');
        const child = machineRequest('machines.setup.adminAccess.set', 'guest-machine');
        const otherDestination = machineRequest('machines.setup.adminAccess.set', 'another-guest-machine');

        const rootReceipt = await create(root);
        expect(home.artifacts.list()).toHaveLength(1);
        const childReceipt = await create(child);
        expect(childReceipt.artifactId).not.toBe(rootReceipt.artifactId);
        expect(home.artifacts.list()).toHaveLength(2);
        const otherReceipt = await create(otherDestination);
        expect(new Set([rootReceipt.artifactId, childReceipt.artifactId, otherReceipt.artifactId]).size).toBe(3);

        for (const { original, receipt } of [
            { original: root, receipt: rootReceipt },
            { original: child, receipt: childReceipt },
            { original: otherDestination, receipt: otherReceipt },
        ]) {
            await expect(create(original)).resolves.toEqual(receipt);
            expect(home.artifacts.readPlainBody(receipt.artifactId)).toBe(JSON.stringify(original));
        }
        const changedChild = ApprovalRequestV2Schema.parse({
            ...child,
            actionArgs: { machineId: 'guest-machine', review: { kind: 'changed-machine-operation' } },
        });
        await expect(create(changedChild)).rejects.toMatchObject({ code: 'approval_request_conflict' });
        expect(home.artifacts.list()).toHaveLength(3);
        expect(home.artifacts.readPlainBody(childReceipt.artifactId)).toBe(JSON.stringify(child));
    });

    it('defers a terminal contributed live-only receipt without another execution claim or write', async () => {
        // This portable owner uses Protocol and relative pure modules. Nonliteral
        // loading runs its real lifecycle without importing the CLI type graph.
        const producerPath = '../../../../../cli/src/session/actions/approvals/targetActionCurrentIntent';
        const producer = await vi.importActual<{
            createTargetActionCurrentIntentAdapter(deps: Readonly<{
                create(request: TargetActionApprovalRequestV1): Promise<Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>>;
                read(artifactId: string): Promise<TargetActionApprovalRequestV1 | null>;
                update(input: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>): Promise<Readonly<
                    { ok: true } | { ok: false; errorCode: string; error: string }>>;
                now(): number;
            }>): (request: unknown) => Promise<import('@happier-dev/protocol/plugins/actions/invocation').PluginActionCurrentIntentResult>;
        }>(producerPath);
        const readArtifact = async (artifactId: string) => {
            const artifact = await fetchArtifactWithBodyFromApi({ ...params, artifactId, fresh: true });
            if (!artifact) return null;
            if (!artifact.isDecrypted || !artifact.rawHeader) throw new Error('Expected opened Artifact header');
            return { header: artifact.rawHeader, body: artifact.body, access: artifact.access };
        };
        let receiptId = '';
        let executionClaims = 0;
        const adapter = producer.createTargetActionCurrentIntentAdapter({
            create: async proposed => {
                const terminal = TargetActionApprovalRequestV1Schema.parse({
                    ...proposed, createdAtMs: 1, status: 'executed', updatedAtMs: 3,
                    decision: { kind: 'approve', decidedAtMs: 2 },
                    execution: { executedAtMs: 3, ok: true, effectAttempted: true },
                });
                receiptId = deriveApprovalRequestArtifactId(terminal, 'account-1');
                await seed(terminal, undefined, receiptId);
                const receipt = await createApprovalRequestArtifact({
                    request: proposed, accountId: 'account-1', newId: () => { throw new Error('Expected captured request identity'); },
                    read: readArtifact,
                    create: async (artifactId, header, body, idScope) => {
                        await createArtifactWithHeaderViaApi({ ...params, artifactId, header, body, idScope, addArtifact: () => {} });
                    },
                });
                expect(receipt.request).toEqual(terminal);
                return receipt;
            },
            read: async artifactId => {
                const artifact = await readArtifact(artifactId);
                if (!artifact || typeof artifact.body !== 'string') return null;
                const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
                if (parsed?.family !== 'target_action') throw new Error('Expected contributed approval receipt');
                return parsed.request;
            },
            update: async ({ artifactId, request }) => {
                executionClaims += 1;
                return await writeApprovalRequestArtifact({
                    artifactId, request,
                    read: async id => fetchArtifactWithBodyFromApi({ ...params, artifactId: id, fresh: true }),
                    write: async (basis, header, body) => {
                        await updateArtifactWithHeaderViaApi({ ...params, artifactId, header, body,
                            getArtifact: () => basis, updateArtifact: () => {} });
                    },
                });
            },
            now: () => 4,
        });
        const result = await adapter({
            action: { qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7',
                sourceCustody: { kind: 'development', registeredRootId: 'root-7' }, dangerLevel: 'writesRemote',
                scopes: ['global'], surfaces: ['agent'], hostAccess: [], input: { value: 'write' },
                policyFingerprint: 'b'.repeat(64), confirmation: { title: 'Apply change' } },
            fingerprint: 'a'.repeat(64), surface: 'agent', approvalInputCustody: 'live_only',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1',
                actionId: 'action.invoke', requestId: 'terminal-contributed-request',
                target: { kind: 'machine', machineId: 'machine-1' } },
        });
        expect(result).toEqual({ status: 'deferred', artifactId: receiptId });
        expect(executionClaims).toBe(0);
        expect(home.artifacts.list()).toHaveLength(1);
        expect(home.artifacts.read(receiptId)).toMatchObject({ headerVersion: 1, bodyVersion: 1 });
        const body = home.artifacts.readPlainBody(receiptId);
        if (body === null) throw new Error('Expected retained contributed receipt');
        expect(TargetActionApprovalRequestV1Schema.parse(JSON.parse(body))).toMatchObject({
            status: 'executed', execution: { executedAtMs: 3, ok: true, effectAttempted: true },
        });
    });

    it('refuses a pre-dispatch failure whose approved basis has already been claimed', async () => {
        const open = openRequest();
        await seed(open);
        const approved = approve(open);
        const write = uiWriter();
        await expect(write(approved)).resolves.toEqual({ ok: true });
        await expect(write(claim(approved))).resolves.toEqual({ ok: true });
        const proposed = ApprovalRequestSchema.parse({ ...settleApprovalRequestReplayInputs(approved), status: 'failed', updatedAtMs: 4,
            execution: { executedAtMs: 4, ok: false, effectAttempted: false,
                errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' } });
        await expect(write(proposed, 'approved')).resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition', writeCommitted: false });
        expect(stored().status).toBe('executing');
    });

    it('keeps target Action subjects immutable and prevents a decision from overwriting a competing CAS', async () => {
        const open = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli',
            qualifiedActionId: 'acme.account-actions/actions/write', input: { key: 'personal' },
            secretInputPaths: [], approvalInputCustody: 'live_only',
            sourceCustody: { kind: 'account_release', pluginId: 'acme.account-actions', version: '1.0.0',
                archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
            policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'c'.repeat(64), summary: 'Write personal value',
        });
        await seed(open);
        const approved = { ...open, status: 'approved' as const, updatedAtMs: 2,
            decision: { kind: 'approve' as const, decidedAtMs: 2 } };
        const write = uiWriter();
        await expect(write({ ...approved, input: { key: 'different' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        home.artifacts.beforeNextUpdate(async () => {
            await expect(uiWriter()({ ...open, status: 'rejected', updatedAtMs: 2,
                decision: { kind: 'reject', decidedAtMs: 2 } })).resolves.toEqual({ ok: true });
        });
        await expect(write(approved)).resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch' });
        await expect(write(approved)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
        expect(TargetActionApprovalRequestV1Schema.parse(JSON.parse(storedJson())))
            .toMatchObject({ status: 'rejected', decision: { kind: 'reject' }, input: open.input });
    });

    it.each([undefined, 'future_builtin_extension'])('preserves the retained V1 Home history index and canonical subject projection (kind: %s)', async kind => {
        const request = ApprovalRequestV1Schema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' }, actionId: 'session.model.set',
            actionArgs: {}, summary: 'Change model',
            ...(kind ? { kind } : {}),
        });
        await seed(request, buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'legacy-home' }));

        if (kind) {
            // Stored reads drop undeclared fields. Reintroducing one on the
            // proposed write changes the immutable subject, not its family.
            await expect(uiWriter()({ ...request, status: 'canceled', updatedAtMs: 2 }))
                .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
            expect(home.artifacts.read(ARTIFACT_ID)?.bodyVersion).toBe(1);
        }
        const basis = await fetchArtifactWithBodyFromApi({ ...params, artifactId: ARTIFACT_ID });
        const canonical = basis?.header && typeof basis.body === 'string'
            ? approvalArtifactBodyMatchesHeaderV1(basis.header, basis.body) : null;
        if (!canonical || canonical.family !== 'built_in') throw new Error('Expected the canonical built-in approval read');
        await expect(uiWriter()({ ...canonical.request, status: 'canceled', updatedAtMs: 2 })).resolves.toEqual({ ok: true });

        const row = home.artifacts.read(ARTIFACT_ID)!;
        expect(decodePlainArtifactStoredContent(row.header)).toMatchObject({
            serverId: 'legacy-home', approvalStatus: 'canceled',
        });
        expect(JSON.parse(storedJson())).toMatchObject({ v: 1, status: 'canceled' });
        expect(JSON.parse(storedJson()).kind).toBeUndefined();
    });

    it('refuses a V2 header that contradicts its body Home instead of adopting the index as authority', async () => {
        const request = openRequest();
        await seed(request, { ...buildApprovalRequestArtifactHeaderV1(request), serverId: 'other-home' });

        await expect(uiWriter()(approve(request))).resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });

        expect(JSON.parse(storedJson())).toMatchObject({ status: 'open', executionOriginV1: { serverId: 'home-1' } });
        expect(home.artifacts.read(ARTIFACT_ID)?.headerVersion).toBe(1);
    });

    it('lets exactly one of two clients claim approved -> executing', async () => {
        await seed(approve(openRequest()));
        const approved = stored();
        const first = uiWriter();
        const second = uiWriter();

        // Both clients read the approved row; the first commits its claim
        // between the second's validated read and its write.
        home.artifacts.beforeNextUpdate(async () => {
            await expect(first(claim(approved))).resolves.toEqual({ ok: true });
        });
        await expect(second(claim(approved))).resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch', writeCommitted: false });
        // A client that reads the winner's claim cannot re-claim it either.
        await expect(second(claim(approved))).resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition', writeCommitted: false });
        expect(stored()).toMatchObject({ status: 'executing' });
    });

    it('does not label a retried claim conflict as uncommitted after its first acknowledgement was lost', async () => {
        const approved = approve(openRequest());
        await seed(approved);
        let claimAttempts = 0;
        const lostAcknowledgement: ServerFetch = async (path, init) => {
            if (init?.method === 'POST') {
                claimAttempts += 1;
                const response = await home.artifacts.handle(path, init);
                if (claimAttempts === 1) {
                    expect(response?.ok).toBe(true);
                    return Response.json({ error: 'acknowledgement_lost' }, { status: 500 });
                }
                if (response) return response;
            }
            return request(path, init);
        };
        const result = await writeApprovalRequestArtifact({
            artifactId: ARTIFACT_ID, request: claim(approved),
            read: async artifactId => fetchArtifactWithBodyFromApi({ ...params, artifactId }),
            write: async (basis, header, body) => updateArtifactWithHeaderViaApi({
                ...params, request: lostAcknowledgement, artifactId: ARTIFACT_ID, header, body,
                getArtifact: () => basis, updateArtifact: () => {},
            }),
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
        expect(result).not.toHaveProperty('writeCommitted');
        expect(stored().status).toBe('executing');
        expect(claimAttempts).toBe(2);
    });

    it.each(['approved', 'executing', 'executed'] as const)('does not let an abandoned open intent cancel a raced %s approval', async status => {
        const open = openRequest();
        await seed(open);
        const write = uiWriter();
        home.artifacts.beforeNextUpdate(async () => {
            const approved = approve(open);
            expect(await write(approved)).toEqual({ ok: true });
            if (status === 'approved') return;
            const executing = claim(approved);
            expect(await write(executing)).toEqual({ ok: true });
            if (status === 'executed') expect(await write({ ...settleApprovalRequestReplayInputs(executing),
                status: 'executed', updatedAtMs: 4, execution: { ok: true, executedAtMs: 4, result: { ok: true } },
            })).toEqual({ ok: true });
        });
        const canceled: ApprovalRequest = { ...settleApprovalRequestReplayInputs(open), status: 'canceled', updatedAtMs: 5 };
        expect(await write(canceled)).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
        expect(await write(canceled)).toMatchObject({ ok: false });
        expect(stored().status).toBe(status);
        expect(stored().decision?.kind).toBe('approve');
    });

    it('does not let an approval built from an open read overwrite a committed rejection', async () => {
        const open = openRequest();
        await seed(open);
        const approver = uiWriter();
        const rejecter = uiWriter();
        home.artifacts.beforeNextUpdate(async () => {
            await expect(rejecter({
                ...open, status: 'rejected', updatedAtMs: 2, decision: { kind: 'reject', decidedAtMs: 2 },
                actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
            })).resolves.toEqual({ ok: true });
        });

        await expect(approver(approve(open))).resolves.toMatchObject({ ok: false });
        expect(stored()).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
        expect(storedJson()).not.toContain(CLIENT_SECRET);
    });

    it('cannot overwrite a committed rejection using the invocation acquisition as its CAS basis', async () => {
        const open = openRequest();
        await seed(open);
        const acquired = await fetchArtifactWithBodyFromApi({ ...params, artifactId: ARTIFACT_ID, fresh: true });
        if (!acquired) throw new Error('Expected acquired approval');
        await expect(uiWriter()({ ...open, status: 'rejected', updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 },
            actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
        })).resolves.toEqual({ ok: true });

        await expect(uiWriter(acquired)(approve(open)))
            .resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch', writeCommitted: false });
        expect(stored()).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
        expect(storedJson()).not.toContain(CLIENT_SECRET);
    });

    it('settles only with the declared input projection and keeps operands immutable before settlement', async () => {
        const open = openRequest();
        await seed(open);
        const write = uiWriter();

        await expect(write({ ...approve(open), actionArgs: { ...open.actionArgs as object, id: 'provider-2' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        await expect(write(approve(open))).resolves.toEqual({ ok: true });
        const executing = claim(stored());
        await expect(write(executing)).resolves.toEqual({ ok: true });
        // Keeping the raw secret on the terminal write is not the declared projection.
        await expect(write({ ...executing, status: 'executed', updatedAtMs: 4, execution: { executedAtMs: 4, ok: true, result: {} } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        await expect(write({
            ...executing, status: 'executed', updatedAtMs: 4, execution: { executedAtMs: 4, ok: true, result: {} },
            actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
        })).resolves.toEqual({ ok: true });
        expect(stored()).toMatchObject({ status: 'executed' });
        expect(storedJson()).not.toContain(CLIENT_SECRET);
    });
});
