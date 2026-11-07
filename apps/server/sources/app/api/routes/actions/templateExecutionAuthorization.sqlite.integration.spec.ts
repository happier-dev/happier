import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { db } from '@/storage/db';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedDiscussionHttpFixture as signedFixture } from './discussionExecutionAuthorization.testkit';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createExternalActionAuthorizedRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';

const content = { v: 1, identity: { name: 'Helper', description: '' }, instructions: { markdown: 'Help.' },
    memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } };
const createBody = (id: string) => ({ id, kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
    header: 'aA==', body: 'Yg==', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
const updateBody = { header: 'aA==', body: 'Yg==', expectedHeaderVersion: 1, expectedBodyVersion: 1 };

describe('signed template parent HTTP purposes', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-execution-auth-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it('uses ordinary bearer Account access for the template author', async () => {
        const f = await signedFixture('template.instantiate', [], true);
        try {
            const path = `/v1/user/${encodeURIComponent(f.account.id)}`;
            const bearer = { authorization: `Bearer ${f.presentUserToken}` };
            expect((await f.app.inject({ method: 'GET', url: path, headers: bearer })).statusCode).toBe(200);
            const root = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } }, true);
            expect((await f.app.inject({ method: 'GET', url: path, headers: {
                ...bearer, [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'template.instantiate',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
            } })).statusCode).toBe(403);
            await expect(f.verify(root, { method: 'GET', path })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('confines a restricted template PAT to its signed purpose', async () => {
        const f = await signedFixture('template.instantiate', [], true);
        try {
            const root = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } });
            const userPath = `/v1/user/${encodeURIComponent(f.account.id)}`;
            expect((await f.app.inject({ method: 'GET', url: userPath,
                headers: { authorization: `Bearer ${f.pat.token}` } })).statusCode).toBe(403);
            await expect(f.verify(root, { method: 'GET', path: '/v1/account/encryption' })).resolves.not.toBeNull();
            await expect(f.verify(root, { method: 'GET', path: userPath,
                routeInput: { id: f.account.id } })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('serves an ordinary Artifact read through a full PAT signed template root', async () => {
        const f = await signedFixture(undefined, [], false, undefined, { artifactReads: true });
        try {
            const artifactId = randomUUID();
            const authorization = await f.mint('template.preview', {
                source: { kind: 'artifact', serverId: 'home', artifactId },
            });
            const path = `/v1/artifacts/${artifactId}`;
            const headers = {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'template.preview',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'template.preview',
                    target: authorization.binding.target, installationId: authorization.binding.installationId,
                    requestId: authorization.binding.requestId, method: 'GET', path, privateKey: f.keyPair.secretKey,
                }),
            };
            // The Artifact is absent. A 404 proves the signed request reached its ordinary resource owner.
            expect((await f.app.inject({ method: 'GET', url: path, headers })).statusCode).toBe(404);
        } finally { await f.app.close(); }
    });

    it('serves ordinary Artifact reads under a full PAT Prompt create root while a scoped PAT cannot', async () => {
        const artifactId = randomUUID();
        const path = `/v1/artifacts/${artifactId}`;
        const full = await signedFixture(undefined, [], false, undefined, { artifactReads: true });
        try {
            const root = await full.mint('prompt_doc.create', { title: 'Saved', markdown: 'Text' });
            const headers = createExternalActionAuthorizedRequestHeaders({ authorization: root,
                effectActionId: root.binding.actionId, target: root.binding.target,
                installationId: full.machine.installationId!, privateKey: full.keyPair.secretKey,
                method: 'GET', path });
            expect((await full.app.inject({ method: 'GET', url: path, headers })).statusCode).toBe(404);
        } finally { await full.app.close(); }
        const scoped = await signedFixture('prompt_doc.create', [], false, undefined, { artifactReads: true });
        try {
            const root = await scoped.mint('prompt_doc.create', { title: 'Saved', markdown: 'Text' });
            await expect(scoped.verify(root, { method: 'GET', path })).resolves.toBeNull();
        } finally { await scoped.app.close(); }
    });

    it('does not accept a Release child role for signed-in link creation', async () => {
        const f = await signedFixture('template.release', [], false, undefined, { signedInLinks: true });
        try {
            const input = { draftArtifactId: randomUUID(),
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
                share: { recipients: [{ kind: 'account', accountId: f.account.id }] } };
            const root = await f.mint('template.release', input, true);
            const child = { actionId: 'artifact.public_link.create', role: 'signed_in_link', inputDigest: 'a'.repeat(43) };
            await expect(f.verify(root, { method: 'POST', path: '/v1/artifact-signed-in-links',
                body: { artifactId: randomUUID(), lookupId: randomUUID() }, reviewedChild: child },
            'artifact.public_link.create')).resolves.toBeNull();
            const patRoot = await f.mint('template.release', input);
            const path = '/v1/artifact-signed-in-links';
            const artifactId = randomUUID();
            await db.artifact.create({ data: { id: artifactId, accountId: f.account.id,
                kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
                header: new Uint8Array([1]), body: new Uint8Array([2]),
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') } });
            const body = { artifactId, lookupId: randomUUID() };
            const headers = createExternalActionAuthorizedRequestHeaders({ authorization: patRoot,
                effectActionId: 'template.release', target: patRoot.binding.target,
                installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey,
                method: 'POST', path, body });
            expect(headers).not.toHaveProperty('authorization');
            const create = await f.app.inject({ method: 'POST', url: path, headers, payload: body });
            expect(create.statusCode, create.body).toBe(400);
            expect(create.json()).not.toEqual({ error: 'invalid_token' });
        } finally { await f.app.close(); }
    });

    it.each([
        { grants: ['template.instantiate'], plan: false, apply: false },
        { grants: ['template.instantiate', 'machines.setup.plan'], plan: true, apply: false },
        { grants: ['template.instantiate', 'machines.setup.plan', 'machines.setup.apply'], plan: true, apply: true },
    ] as const)('admits ordinary Machine setup only under its own scoped PAT grants ($grants)', async ({ grants, plan, apply }) => {
        const f = await signedFixture('template.instantiate', [], false, undefined, { allowedActionIds: grants });
        try {
            const root = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } });
            const homeId = root.binding.serverIdentityId;
            const planInput = MachineSetupPlanInputV1Schema.parse({ homeId, machineId: f.machine.id });
            const applyInput = MachineSetupApplyInputV1Schema.parse({ homeId, machineId: f.machine.id,
                targets: [{ homeId, machineId: f.machine.id, sources: [{ kind: 'direct', setup: {} }],
                    desiredRevision: 0, recipePlans: [] }] });
            const mint = (actionId: 'machines.setup.plan' | 'machines.setup.apply', input: unknown) => f.app.inject({
                method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${f.pat.token}` },
                payload: { v: 1, machineId: f.machine.id, envelope: ExternalActionRequestEnvelopeV1Schema.parse({
                    v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: f.machine.id }, input,
                }) },
            });
            const planned = await mint('machines.setup.plan', planInput);
            expect(planned.statusCode, planned.body).toBe(plan ? 200 : 403);
            if (plan) expect(ExternalActionExecutionAuthorizationV1Schema.parse(planned.json()).binding)
                .toMatchObject({ actionId: 'machines.setup.plan', machineId: f.machine.id, admittedMachineRole: 'manage' });
            else expect(planned.json()).toEqual({ error: 'credential_scope_denied' });
            const applied = await mint('machines.setup.apply', applyInput);
            expect(applied.statusCode, applied.body).toBe(apply ? 200 : 403);
            if (apply) expect(ExternalActionExecutionAuthorizationV1Schema.parse(applied.json()).binding)
                .toMatchObject({ actionId: 'machines.setup.apply', machineId: f.machine.id, admittedMachineRole: 'manage' });
            else expect(applied.json()).toEqual({ error: 'credential_scope_denied' });
        } finally { await f.app.close(); }
    });

    it.each([
        { actionId: 'machines.setup.plan', grants: ['template.instantiate', 'machines.setup.plan'], admitted: true },
        { actionId: 'machines.setup.plan', grants: ['template.instantiate'], admitted: false },
        { actionId: 'machines.setup.apply', grants: ['template.instantiate', 'machines.setup.apply'], admitted: true },
        { actionId: 'machines.setup.apply', grants: ['template.instantiate'], admitted: false },
    ] as const)('spends a reviewed $actionId HTTP child only with its own scoped PAT grant ($admitted)',
        async ({ actionId, grants, admitted }) => {
            const f = await signedFixture('template.instantiate', [], false, undefined, { allowedActionIds: grants });
            try {
                const root = await f.mint('template.instantiate', { source: { kind: 'artifact', artifactId: randomUUID() } });
                const path = '/v1/account/encryption/currentness';
                const headers = createExternalActionAuthorizedRequestHeaders({ authorization: root,
                    effectActionId: actionId, target: root.binding.target,
                    installationId: f.machine.installationId!, privateKey: f.keyPair.secretKey,
                    reviewedChild: { actionId, role: 'setup.target', inputDigest: 'a'.repeat(43) },
                    method: 'GET', path });
                expect(headers).not.toHaveProperty('authorization');
                const response = await f.app.inject({ method: 'GET', url: path, headers });
                expect(response.statusCode, response.body).toBe(admitted ? 200 : 401);
                if (!admitted) expect(response.json()).toMatchObject({ error: 'invalid_token' });
            } finally { await f.app.close(); }
        });

    it.each(['artifact.public_link.create', 'artifact.public_link.list', 'artifact.public_link.revoke'] as const)(
        '%s spends only its signed-in link management phase', async actionId => {
            const f = await signedFixture(actionId);
            try {
                const artifactId = randomUUID();
                const lookupId = randomUUID();
                const input = { artifactId, audience: 'signed_in',
                    ...(actionId === 'artifact.public_link.revoke' ? { shareId: artifactId } : {}) };
                const authorization = await f.mint(actionId, input, actionId === 'artifact.public_link.create');
                const collection = '/v1/artifact-signed-in-links';
                const body = { artifactId, lookupId };
                const request = actionId === 'artifact.public_link.create'
                    ? { method: 'POST', path: collection, body, routeInput: body }
                    : actionId === 'artifact.public_link.list'
                        ? { method: 'GET', path: `${collection}?artifactId=${artifactId}`, routeInput: { artifactId } }
                        : { method: 'DELETE', path: `${collection}/${artifactId}`, routeInput: { artifactId } };
                await expect(f.verify(authorization, request)).resolves.not.toBeNull();
                await expect(f.verify(authorization, { method: 'GET', path: `/v1/artifacts/${artifactId}`,
                    routeInput: { id: artifactId } })).resolves.not.toBeNull();
                await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' })).resolves.not.toBeNull();
                await expect(f.verify(authorization, { ...request, method: 'PUT' })).resolves.toBeNull();
                await expect(f.verify(authorization, { ...request, routeInput: { artifactId: randomUUID() } })).resolves.toBeNull();
                await expect(f.verify(authorization, { ...request, path: `${request.path}${request.path.includes('?') ? '&' : '?'}extra=1` })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'POST', path: `${collection}/${lookupId}/join`, body: {} })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'POST', path: '/v1/public-shares',
                    body: { subject: { kind: 'artifact', id: artifactId }, lookupId, keyDerivation: 'fragment_v1' } })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `/v1/artifacts/${artifactId}/access/grants`,
                    body: { artifactId, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'admin' } })).resolves.toBeNull();
                await expect(f.verify(authorization, request, 'artifact.public_link.join')).resolves.toBeNull();
                if (actionId === 'artifact.public_link.create') {
                    const automation = await f.mint(actionId, input);
                    await expect(f.verify(automation, request)).resolves.toBeNull();
                    await expect(f.verify(authorization, { ...request, body: { ...body, unexpected: true } })).resolves.toBeNull();
                    await expect(f.verify(authorization, { ...request, body: { ...body, encryptedDataKey: 'sealed-key' },
                        routeInput: { ...body, encryptedDataKey: 'sealed-key' } })).resolves.not.toBeNull();
                }
                if (actionId === 'artifact.public_link.revoke') {
                    await expect(f.verify(authorization, { method: 'GET', path: `${collection}?artifactId=${artifactId}`,
                        routeInput: { artifactId } })).resolves.not.toBeNull();
                }
            } finally { await f.app.close(); }
        });

    it('signed-in join retains exact lookup preparation and self-envelope commit without grant or publication authority', async () => {
        const f = await signedFixture('artifact.public_link.join');
        try {
            const lookupId = randomUUID();
            const authorization = await f.mint('artifact.public_link.join', { lookupId });
            const path = `/v1/artifact-signed-in-links/${lookupId}/join`;
            const routeInput = { lookupId };
            await expect(f.verify(authorization, { method: 'GET', path, routeInput })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: {}, routeInput })).resolves.not.toBeNull();
            const recipientKey = tweetnacl.box.keyPair();
            const keyEnvelope = { recipientAccountId: f.account.id,
                encryptedDataKey: encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                    recipientPublicKey: recipientKey.publicKey, randomBytes: tweetnacl.randomBytes }))),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKey.publicKey) };
            await expect(f.verify(authorization, { method: 'POST', path, body: { keyEnvelope },
                routeInput: { ...routeInput, keyEnvelope } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { lookupId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: {}, routeInput: { lookupId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, body: {} })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}?lookupId=other` })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifact-signed-in-links/%ZZ/join' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path, body: {} })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: { recipientAccountId: f.account.id } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: { keyEnvelope: {} } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifact-signed-in-links',
                body: { artifactId: randomUUID(), lookupId } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifacts' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'artifact.get')).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['template.preview', 'template.export_file'] as const)('%s retains only its exact Artifact codec purposes on a restricted PAT', async actionId => {
        const f = await signedFixture(actionId);
        try {
            const id = randomUUID();
            const authorization = await f.mint(actionId, { source: { kind: 'artifact', serverId: 'home', artifactId: id },
                ...(actionId === 'template.export_file' ? { skillKey: 'guide', path: 'SKILL.md' } : {}) });
            const path = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}/access/grants`, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}/access/recipients`, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/access/key-envelopes`, body: {
                artifactId: id, expectedDataEncryptionKey: 'A'.repeat(140), recipientKeyEnvelopes: [],
            } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/account/encryption/currentness' })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/features/authenticated' })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { id: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path, body: {} })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}?extra=1` })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifacts' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(id) })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: updateBody })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'artifact.get')).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'template.draft')).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('draft retains Artifact publication and owner metadata CAS, with no grant or Session lifecycle effect', async () => {
        const sessionId = 'cmvtemplate-source';
        const f = await signedFixture('template.draft', [sessionId]);
        try {
            const id = randomUUID();
            const authorization = await f.mint('template.draft', { sourceSessionRef: { serverId: 'home', sessionId }, content });
            const artifactPath = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(id) })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: artifactPath, body: updateBody,
                routeInput: { id, ...updateBody } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: '/v1/artifacts', body: createBody(id) })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: { ...createBody(id), unexpected: true } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: artifactPath, body: { ...updateBody, unexpected: true } })).resolves.toBeNull();
            const sessionPath = `/v2/sessions/${sessionId}`;
            const sessionRouteTarget = { kind: 'session' as const, sessionId };
            await expect(f.verify(authorization, { method: 'GET', path: `${sessionPath}?accessProjectionVersion=1`, sessionRouteTarget })).resolves.not.toBeNull();
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: ownerPatch, sessionRouteTarget })).resolves.not.toBeNull();
            const migrationPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner_migration', expectedAccountEncryptionMode: 'plain',
                expectedAccountContentPublicKeyFingerprint: null,
                source: { metadataLayoutVersion: 0, metadata: { version: 0, ciphertext: '{}' }, ownerMetadata: null,
                    agentState: { version: 0, ciphertext: null } },
                target: { metadataLayoutVersion: 1, sharedMetadata: { ciphertext: '{}' }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                    agentState: { ciphertext: null } } });
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: migrationPatch, sessionRouteTarget })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: { mode: 'shared_editor', metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 } }, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${sessionPath}/archive`, body: {}, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${artifactPath}/access/grants`, body: {
                artifactId: id, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' } })).resolves.toBeNull();
            for (const principal of [{ kind: 'team', teamId: 'cmvtemplate-team' },
                { kind: 'group', teamId: 'cmvtemplate-team', groupId: 'cmvtemplate-group' }]) {
                await expect(f.verify(authorization, { method: 'PUT', path: `${artifactPath}/access/grants`, body: {
                    artifactId: id, principal, accessLevel: 'view' } })).resolves.toBeNull();
            }
            await expect(f.verify(authorization, { method: 'DELETE', path: artifactPath })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('instantiate retains content writes, source reads, private accepted-base creation and recipient owner metadata only', async () => {
        const sessionId = 'cmvtemplate-recipient';
        const f = await signedFixture('template.instantiate', [sessionId]);
        try {
            const id = randomUUID();
            const authorization = await f.mint('template.instantiate', {
                source: { kind: 'artifact', serverId: 'home', artifactId: id }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                creation: { creationKey: randomUUID(), executionTarget: { serverId: 'home', machineId: f.machine.id },
                    directory: { kind: 'path', path: '/work' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
            });
            const path = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'GET', path, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: `${path}/access/grants`, routeInput: { id } })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()) })).resolves.not.toBeNull();
            const sessionPath = `/v2/sessions/${sessionId}`;
            const sessionRouteTarget = { kind: 'session' as const, sessionId };
            await expect(f.verify(authorization, { method: 'GET', path: sessionPath, sessionRouteTarget })).resolves.not.toBeNull();
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: ownerPatch, sessionRouteTarget })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path: '/v1/artifacts' })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: updateBody })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: {
                artifactId: id, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PATCH', path: sessionPath, body: { mode: 'shared_editor', metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 } }, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${sessionPath}/archive`, body: {}, sessionRouteTarget })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'GET', path }, 'artifact.get')).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['template.updates.diff', 'template.updates.apply', 'template.updates.skip', 'template.follow.stop'] as const)(
        '%s retains its own read or owner-mutation scope without spending sibling effects', async actionId => {
        const sessionId = 'cmvtemplate-update-recipient';
        const f = await signedFixture(actionId, [sessionId]);
        try {
            const authorization = await f.mint(actionId, { sessionRef: { serverId: 'home', sessionId },
                ...(actionId === 'template.updates.apply' ? { expectedVersion: '1.1.0' } : {}),
                ...(actionId === 'template.updates.skip' ? { version: '1.1.0' } : {}) });
            const path = `/v2/sessions/${sessionId}`;
            const sessionRouteTarget = { kind: 'session' as const, sessionId };
            await expect(f.verify(authorization, { method: 'GET', path, sessionRouteTarget })).resolves.not.toBeNull();
            const ownerPatch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
            const mutation = f.verify(authorization, { method: 'PATCH', path, body: ownerPatch, sessionRouteTarget });
            if (actionId === 'template.updates.diff') await expect(mutation).resolves.toBeNull();
            else await expect(mutation).resolves.not.toBeNull();
            const artifactId = randomUUID();
            const read = f.verify(authorization, { method: 'GET', path: `/v1/artifacts/${artifactId}`, routeInput: { id: artifactId } });
            if (actionId === 'template.updates.diff' || actionId === 'template.updates.apply') await expect(read).resolves.not.toBeNull();
            else await expect(read).resolves.toBeNull();
            const create = f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(randomUUID()) });
            if (actionId === 'template.updates.apply') await expect(create).resolves.not.toBeNull();
            else await expect(create).resolves.toBeNull();
            const update = f.verify(authorization, { method: 'POST', path: `/v1/artifacts/${artifactId}`, body: updateBody });
            if (actionId === 'template.updates.apply') await expect(update).resolves.not.toBeNull();
            else await expect(update).resolves.toBeNull();
            const catalogWrite = f.verify(authorization, { method: 'POST', path: MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
                body: { expectedRevision: 1, content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } } });
            if (actionId === 'template.updates.apply') await expect(catalogWrite).resolves.not.toBeNull();
            else await expect(catalogWrite).resolves.toBeNull();
            const cleanup = f.verify(authorization, { method: 'DELETE', path: `/v1/artifacts/${artifactId}`, routeInput: { id: artifactId } });
            if (actionId === 'template.updates.apply') await expect(cleanup).resolves.not.toBeNull();
            else await expect(cleanup).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/archive`, body: {}, sessionRouteTarget })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['template.instantiate', 'template.updates.apply', 'template.preview'] as const)(
        '%s spends only its exact closed accepted-version report purpose', async actionId => {
        const sessionId = 'cmvtemplate-accepted-report';
        const f = await signedFixture(actionId, [sessionId]);
        try {
            const source = { kind: 'artifact', serverId: 'home', artifactId: randomUUID() };
            const authorization = await f.mint(actionId, actionId === 'template.updates.apply'
                ? { sessionRef: { serverId: 'home', sessionId }, expectedVersion: '1.1.0' }
                : actionId === 'template.preview' ? { source }
                : { source, expectedVersion: '1.0.0', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                    creation: { creationKey: randomUUID(), executionTarget: { serverId: 'home', machineId: f.machine.id },
                        directory: { kind: 'path', path: '/work' },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } });
            const body = { artifactId: source.artifactId, copyId: sessionId, acceptedVersion: '1.0.0' };
            const request = { method: 'PUT', path: `/v1/artifacts/${body.artifactId}/access/accepted-version`,
                body, routeInput: { id: body.artifactId, ...body } };
            const accepted = f.verify(authorization, request);
            if (actionId === 'template.preview') await expect(accepted).resolves.toBeNull();
            else await expect(accepted).resolves.not.toBeNull();
            await expect(f.verify(authorization, { ...request, body: { ...body, unexpected: true } })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, body: { ...body, artifactId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, routeInput: { ...request.routeInput, id: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, path: `${request.path}?extra=1` })).resolves.toBeNull();
            await expect(f.verify(authorization, { ...request, method: 'POST' })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('release retains Account, Team and Group Can-copy grants and key delivery, excluding edit, anonymous links and removal', async () => {
        const f = await signedFixture('template.release');
        try {
            const id = randomUUID();
            await db.artifact.create({ data: { id, accountId: f.account.id,
                kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
                header: new Uint8Array([1]), body: new Uint8Array([2]),
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') } });
            const authorization = await f.mint('template.release', { draftArtifactId: randomUUID(),
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
                share: { recipients: [{ kind: 'account', accountId: f.account.id }, { kind: 'team', teamId: 'cmvtemplate-team' },
                    { kind: 'group', teamId: 'cmvtemplate-team', groupId: 'cmvtemplate-group' }] } });
            const path = `/v1/artifacts/${id}`;
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts', body: createBody(id) })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path, body: updateBody })).resolves.not.toBeNull();
            const grant = { artifactId: id, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' };
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: grant,
                routeInput: { id, ...grant } })).resolves.not.toBeNull();
            const commit = { artifactId: id, expectedDataEncryptionKey: 'A'.repeat(140), recipientKeyEnvelopes: [] };
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/access/key-envelopes`, body: commit })).resolves.not.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: `${path}/access/key-envelopes`, body: { ...commit, artifactId: randomUUID() } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: { ...grant, accessLevel: 'edit' } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: { ...grant, accessLevel: 'admin' } })).resolves.toBeNull();
            for (const principal of [{ kind: 'team', teamId: 'cmvtemplate-team' },
                { kind: 'group', teamId: 'cmvtemplate-team', groupId: 'cmvtemplate-group' }]) {
                const sharedGrant = { ...grant, principal };
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: sharedGrant,
                    routeInput: { id, ...sharedGrant } })).resolves.not.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`,
                    body: { ...sharedGrant, artifactId: randomUUID() } })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: sharedGrant,
                    routeInput: { id: randomUUID(), ...sharedGrant } })).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'PUT', path: `${path}/access/grants`, body: sharedGrant },
                    'artifact.public_link.create')).resolves.toBeNull();
            }
            await expect(f.verify(authorization, { method: 'DELETE', path: `${path}/access/grants`, body: grant })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/public-shares', body: { subjectKind: 'artifact', subjectId: id } })).resolves.toBeNull();
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifacts/content/binary', body: createBody(id) })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('refuses a restricted Release token sharing an owned non-template Artifact', async () => {
        const f = await signedFixture('template.release');
        try {
            const artifactId = randomUUID();
            await db.artifact.create({ data: { id: artifactId, accountId: f.account.id,
                kind: deriveArtifactStoredKindV1({ kind: 'prompt_doc.v2' }),
                header: new Uint8Array([1]), body: new Uint8Array([2]), dataEncryptionKey: new Uint8Array([3]) } });
            const authorization = await f.mint('template.release', { draftArtifactId: randomUUID(),
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
                share: { recipients: [{ kind: 'account', accountId: f.account.id }] } });
            const grant = { artifactId, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' };
            await expect(f.verify(authorization, { method: 'PUT',
                path: `/v1/artifacts/${artifactId}/access/grants`, body: grant,
                routeInput: { id: artifactId, ...grant } })).resolves.toBeNull();
            const link = { artifactId, lookupId: randomUUID() };
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifact-signed-in-links',
                body: link, routeInput: link })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it('leaves a full PAT Release root at the ordinary Artifact owner for a non-template Artifact', async () => {
        const f = await signedFixture();
        try {
            const artifactId = randomUUID();
            await db.artifact.create({ data: { id: artifactId, accountId: f.account.id,
                kind: deriveArtifactStoredKindV1({ kind: 'prompt_doc.v2' }),
                header: new Uint8Array([1]), body: new Uint8Array([2]), dataEncryptionKey: new Uint8Array([3]) } });
            const authorization = await f.mint('template.release', { draftArtifactId: randomUUID(),
                expectedRevision: { headerVersion: 1, bodyVersion: 1 }, version: '1.0.0', changelog: '',
                share: { recipients: [{ kind: 'account', accountId: f.account.id }] } });
            const grant = { artifactId, principal: { kind: 'account', accountId: f.account.id }, accessLevel: 'view' };
            await expect(f.verify(authorization, { method: 'PUT',
                path: `/v1/artifacts/${artifactId}/access/grants`, body: grant,
                routeInput: { id: artifactId, ...grant } })).resolves.not.toBeNull();
            const link = { artifactId, lookupId: randomUUID() };
            await expect(f.verify(authorization, { method: 'POST', path: '/v1/artifact-signed-in-links',
                body: link, routeInput: link })).resolves.not.toBeNull();
        } finally { await f.app.close(); }
    });
});
