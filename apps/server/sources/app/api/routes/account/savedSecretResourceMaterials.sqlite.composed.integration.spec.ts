import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    AIBackendProfileSchema,
    DEFAULT_PROVIDER_SETTINGS_V1,
    type FeaturesResponse,
    FeaturesResponseSchema,
    formatSharedSavedSecretRefV1,
    promotePersonalSavedSecretReference,
    sealEncryptedDataKeyEnvelopeV1,
    sealSavedSecretResourceStoredContentV1,
    signAccountContentKeyBindingV1,
    verifyAccountContentKeyBindingV1,
    ProviderSettingsV1Schema,
    SavedSecretResourceMaterialsResponseV1Schema,
    SharedSavedSecretListOutputV1Schema,
    SharedSavedSecretPromoteInputV1Schema,
    VoiceCredentialBindingIdentityV1Schema,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import {
    createSavedSecretResourceInTx,
    promoteSavedSecretResourceInTx,
} from "@/app/account/savedSecrets/savedSecretResourceService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { registerSavedSecretResourceRoutes } from "./registerSavedSecretResourceRoutes";
import { registerAccountEncryptionRoutes } from "./registerAccountEncryptionRoutes";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";
import { registerAccountSettingsHistoryRoutes } from "./registerAccountSettingsHistoryRoutes";
import { registerConnectedAccountConfigurationRowsRoutes } from "@/app/account/connectedAccounts/registerConfigurationRowsRoutes";
import { readProfileReferenceGuardInTx } from '@/app/account/profiles/profileRows';
import type { FastifyRequest } from "fastify";
import { sealPromptLibraryContentV1, PromptLibraryRowReadResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { RegistrySourcesRecordV1Schema } from '@happier-dev/protocol/registries/registrySourcesV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { mutatePromptLibraryRowInTx, readPromptLibraryRowInTx } from '@/app/account/prompts/promptLibraryRows';

async function importCliTestModule<T>(specifier: string): Promise<T> {
    // This composition deliberately crosses the server/CLI workspace boundary.
    // Keep server compilation rooted locally while Vitest loads the real consumers.
    return import(specifier) as Promise<T>;
}

function createE2eeAccountMaterial() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const contentPublicKeySig = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signing.secretKey,
        contentPublicKey: content.publicKey,
    });
    const verified = verifyAccountContentKeyBindingV1({
        accountSigningPublicKey: signing.publicKey,
        contentPublicKey: content.publicKey,
        signature: contentPublicKeySig,
    });
    if (!verified) throw new Error("test binding must verify");
    return {
        account: {
            encryptionMode: "e2ee" as const,
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            contentPublicKey: Buffer.from(content.publicKey),
            contentPublicKeySig: Buffer.from(contentPublicKeySig),
        },
        contentPublicKey: content.publicKey,
        fingerprint: verified.contentPublicKeyFingerprint,
    };
}

function sealTestDataKey(recipientPublicKey: Uint8Array): Uint8Array {
    return sealEncryptedDataKeyEnvelopeV1({
        dataKey: new Uint8Array(32).fill(7),
        recipientPublicKey,
        randomBytes: (length) => new Uint8Array(length).fill(9),
    });
}

function sealTestResource(resourceId: string) {
    return sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: "e2ee",
        resourceDataKey: new Uint8Array(32).fill(7),
        content: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
        randomBytes: (length) => new Uint8Array(length).fill(8),
    });
}

describe("Saved Secret material route (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-saved-secret-material-route-",
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" },
            initEncrypt: true,
        });
    }, 180_000);

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.savedSecretResourceKeyEnvelope.deleteMany(),
            () => db.savedSecretGroupGrant.deleteMany(),
            () => db.savedSecretTeamGrant.deleteMany(),
            () => db.savedSecretAccountGrant.deleteMany(),
            () => db.savedSecretResource.deleteMany(),
            () => db.accountSettingsSnapshot.deleteMany(),
            () => db.teamGroupMembership.deleteMany(),
            () => db.teamGroup.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.accountPasswordCredential.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.managedMachine.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => harness.close());

    it('selects one exact managed revision before disclosing material and rejects use-only readers', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: 'friend' } });
        for (const resourceId of ['managed-reveal', 'unrelated-reveal']) {
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
                accountId: owner.id, resourceId, displayName: resourceId, kind: 'password', encryptionMode: 'plain',
                accountGrants: [recipient.id],
                storedContent: { t: 'plain', v: { v: 1, name: resourceId, kind: 'password', value: `${resourceId}-sentinel` } },
            }))).toMatchObject({ ok: true });
        }
        let accountId = owner.id;
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = accountId; });
        registerSavedSecretResourceRoutes(app);
        try {
            const path = '/v1/account/saved-secrets/resources/materials?resourceId=managed-reveal&expectedRevision=1&requireManage=true';
            const current = await app.inject({ method: 'GET', url: path });
            expect(current.statusCode).toBe(200);
            expect(current.json().resources.map((row: { resourceId: string }) => row.resourceId)).toEqual(['managed-reveal']);
            expect(current.body).not.toContain('unrelated-reveal-sentinel');
            const stale = await app.inject({ method: 'GET', url: path.replace('expectedRevision=1', 'expectedRevision=2') });
            expect(stale.statusCode).toBe(409);
            expect(stale.json()).toEqual({ error: 'resource_changed' });
            accountId = recipient.id;
            const useOnly = await app.inject({ method: 'GET', url: path });
            expect(useOnly.statusCode).toBe(403);
            expect(useOnly.body).not.toContain('managed-reveal-sentinel');
        } finally { await app.close(); }
    });

    it('answers an unauthorized revision probe exactly like a nonexistent resource while owners keep currentness', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId: 'probe-target', displayName: 'probe-target', kind: 'password', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'probe-target', kind: 'password', value: 'probe-target-sentinel' } },
        }))).toMatchObject({ ok: true, value: { revision: 1 } });
        let accountId = stranger.id;
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = accountId; });
        registerSavedSecretResourceRoutes(app);
        const probe = (resourceId: string, revision: number) => app.inject({ method: 'GET',
            url: `/v1/account/saved-secrets/resources/materials?resourceId=${resourceId}&expectedRevision=${revision}` });
        try {
            const probes = await Promise.all([probe('probe-target', 1), probe('probe-target', 2), probe('probe-missing', 1)]);
            const observed = probes.map(response => ({ status: response.statusCode, body: response.body }));
            expect(observed[0]).toEqual(observed[2]);
            expect(observed[1]).toEqual(observed[2]);
            expect(observed[2]).toEqual({ status: 404, body: JSON.stringify({ error: 'resource_not_found' }) });
            accountId = owner.id;
            const current = await probe('probe-target', 1);
            expect(current.statusCode).toBe(200);
            expect(current.json().resources.map((row: { resourceId: string }) => row.resourceId)).toEqual(['probe-target']);
            const stale = await probe('probe-target', 2);
            expect(stale.statusCode).toBe(409);
            expect(stale.json()).toEqual({ error: 'resource_changed' });
            expect((await probe('probe-missing', 1)).json()).toEqual({ error: 'resource_not_found' });
        } finally { await app.close(); }
    });

    it('answers no-access management probes like a missing resource and keeps forbidden for use-only recipients', async () => {
        Object.assign(process.env, { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const emailPassword = { kind: 'home_method' as const, methodId: 'email_password' };
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: 'friend' } });
        const team = await db.team.create({ data: { name: 'Restricted audience',
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: [emailPassword] } } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: member.id, role: 'member' },
        ] });
        for (const accountId of [owner.id, member.id]) {
            await db.accountIdentity.create({ data: { accountId, provider: 'email', providerUserId: `${accountId}@example.test`, profile: {} } });
            await db.accountPasswordCredential.create({ data: { accountId, credential: { v: 1, kind: 'plain_password_hash',
                hash: await hashPasswordMaterial(new TextEncoder().encode(`${accountId} password factor`)) } } });
        }
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId: 'managed-target', displayName: 'managed-target', kind: 'password', encryptionMode: 'plain',
            authentication: { env: process.env, authenticationAuthority: 'present_user', authenticationEvidence: [emailPassword] },
            accountGrants: [recipient.id], teamGrants: [team.id],
            storedContent: { t: 'plain', v: { v: 1, name: 'managed-target', kind: 'password', value: 'managed-target-sentinel' } },
        }))).toMatchObject({ ok: true, value: { revision: 1 } });
        let headers: Record<string, string> = {};
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => { Object.assign(request.headers, headers); });
        registerSavedSecretResourceRoutes(app);
        const as = (accountId: string, evidence?: readonly unknown[]) => {
            headers = { 'x-test-user-id': accountId, ...(evidence ? { 'x-test-authentication-evidence': JSON.stringify(evidence) } : {}) };
        };
        const ask = async (resourceId: string) => {
            const responses = await Promise.all([
                app.inject({ method: 'GET', url: `/v1/account/saved-secrets/resources/envelope-census?resourceId=${resourceId}` }),
                app.inject({ method: 'GET', url: `/v1/account/saved-secrets/resources/materials?resourceId=${resourceId}&expectedRevision=1&requireManage=true` }),
                app.inject({ method: 'GET', url: `/v1/account/saved-secrets/resources/materials?resourceId=${resourceId}&expectedRevision=1` }),
            ]);
            return responses.map(response => ({ status: response.statusCode, body: response.body }));
        };
        try {
            as(stranger.id);
            const missing = await ask('managed-missing');
            expect(missing.map(row => row.status)).toEqual([404, 404, 404]);
            expect(await ask('managed-target')).toEqual(missing);
            // A Team member whose credential does not qualify for the restricted Team grant has no access.
            as(member.id);
            expect(await ask('managed-target')).toEqual(missing);
            // Callers with use access already know the resource exists; they lack only management.
            as(member.id, [emailPassword]);
            expect((await ask('managed-target')).map(row => row.status)).toEqual([403, 403, 200]);
            as(recipient.id);
            expect((await ask('managed-target')).map(row => row.status)).toEqual([403, 403, 200]);
            as(owner.id, [emailPassword]);
            expect((await ask('managed-target')).map(row => row.status)).toEqual([400, 200, 200]);
        } finally { await app.close(); }
    });

    it.each([true, false])('promotes a personal registry token through the real Action route and refuses its deletion (explicit mapping: %s)', async explicitMapping => {
        const personal = { id: 'registry-personal', name: 'Registry token', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'private-registry-token' }, createdAt: 1, updatedAt: 1 };
        const raw = { secrets: [personal] };
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: raw }) } });
        const registrySources = RegistrySourcesRecordV1Schema.parse({ v: 2, disabledSourceIds: [], sources: [{
            id: 'registry:private', title: 'Private', format: 'git', kinds: ['skill'], url: 'https://github.com/acme/private',
            enabled: true, addedAt: 1, token: { secretRef: personal.id } }] });
        const content = sealPromptLibraryContentV1({ mode: 'plain', material: null, record: { key: 'registry-sources', value: registrySources } });
        expect(await inTx(tx => mutatePromptLibraryRowInTx(tx, { accountId: owner.id, key: 'registry-sources',
            expectedRevision: 'absent', sourceSettingsVersion: 0, content,
            referencedSavedSecretIds: [personal.id] }))).toMatchObject({ status: 'updated', revision: 0 });
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id,
            source: { kind: 'personal-saved-secret', secretId: personal.id } });
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const promoted = promotePersonalSavedSecretReference(raw, { secretId: personal.id, expectedUpdatedAt: 1,
            sharedSecretRef: ref }, { profileRecords: [], registrySources });
        const input = SharedSavedSecretPromoteInputV1Schema.parse({ resourceId, displayName: personal.name, kind: personal.kind,
            encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: personal.name, kind: personal.kind, value: personal.encryptedValue.value } },
            expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: promoted.settings }, profileMutations: [],
            ...(explicitMapping ? { personalSecretPromotions: [{ personalSecretId: personal.id, resourceId }] } : {}),
            referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
                catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent',
                    connectedPurposes: 'absent', registrySources: 0 } },
            catalogMutations: { registrySources: { expectedRevision: 0, referencedSavedSecretIds: [ref],
                savedSecretRevisions: [{ resourceId, expectedRevision: 1 }],
                content: sealPromptLibraryContentV1({ mode: 'plain', material: null,
                    record: { key: 'registry-sources', value: RegistrySourcesRecordV1Schema.parse(promoted.registrySources) } }) } } });
        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        try {
            const omitted = await app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/promote',
                headers: { 'x-test-user-id': owner.id }, payload: { ...input, catalogMutations: undefined } });
            expect(omitted.statusCode).toBe(400);
            expect(omitted.json()).toMatchObject({ error: 'references_invalid' });
            expect(await db.savedSecretResource.count()).toBe(0);
            const uncaptured = await app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/promote',
                headers: { 'x-test-user-id': owner.id }, payload: { ...input, nextSettings: null,
                    personalSecretPromotions: undefined, referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: { registrySources: 0 } },
                    catalogMutations: { registrySources: { expectedRevision: 0, content: input.catalogMutations?.registrySources?.content } } } });
            expect(uncaptured.statusCode).toBe(400);
            expect(uncaptured.json()).toMatchObject({ error: 'references_invalid' });
            expect(await db.savedSecretResource.count()).toBe(0);
            const promote = await app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/promote',
                headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(promote.statusCode).toBe(200);
            expect(promote.json()).toMatchObject({ resourceId, settingsVersion: 1, catalogRevisions: { registrySources: 1 } });
            const read = PromptLibraryRowReadResponseV1Schema.parse(await inTx(tx => readPromptLibraryRowInTx(tx,
                { accountId: owner.id, key: 'registry-sources' })));
            expect(read).toMatchObject({ status: 'present', revision: 1, content: { t: 'plain', v: { key: 'registry-sources',
                value: { sources: [{ token: { secretRef: ref } }] } } } });
            const guard = await inTx(tx => readProfileReferenceGuardInTx(tx, { accountId: owner.id }));
            if (guard.status !== 'present') throw new Error('Committed promotion must advance the guard');
            const deleted = await app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/delete',
                headers: { 'x-test-user-id': owner.id }, payload: { resourceId, expectedRevision: 1, expectedSettingsVersion: 1,
                    referenceCensus: { ...input.referenceCensus, catalogs: { ...input.referenceCensus.catalogs, registrySources: 1 },
                        profiles: { referenceGuardRevision: guard.revision, rows: [] } } } });
            expect(deleted.statusCode).toBe(409);
            expect(deleted.json()).toMatchObject({ error: 'resource_in_use' });
            expect(await db.savedSecretResource.count()).toBe(1);
        } finally { await app.close(); }
    });

    it("reviews retained managed bootstrap custody before deleting a Saved Secret without claiming native deletion", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const resourceId = "managed-bootstrap-secret";
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId, displayName: "Bootstrap", kind: "other", encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Bootstrap", kind: "other", value: "private-bootstrap-value" } },
        }));
        const controller = await db.machine.create({ data: {
            id: "bootstrap-review-controller", accountId: owner.id, metadata: '{"t":"plain","v":{}}', installationId: "bootstrap-review-installation",
        } });
        const provider = { pluginId: "fixture.compute", localId: "cloud" };
        const managed = await db.managedMachine.create({ data: {
            homeId: "bootstrap-review-home", custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
            admittedActionRequestId: "bootstrap-review-request", admittedInput: {},
            launch: { provider, schemaVersion: 1, name: "Retained", choices: {} },
            allocation: "bound", resource: { contributionRef: provider, schemaVersion: 1, value: { id: "native-bootstrap" } },
            bootstrapCredentialRef: { kind: "shared_resource", resourceId },
            retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
            recovery: { reference: "native-bootstrap", reason: "manual_recovery" },
        } });
        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        try {
            const payload = { resourceId, expectedRevision: 1, expectedSettingsVersion: 0,
                referenceCensus: { accountMode: "plain", profiles: { referenceGuardRevision: "absent", rows: [] } } };
            const review = await app.inject({ method: "POST", url: "/v1/account/saved-secrets/resources/delete",
                headers: { "x-test-user-id": owner.id }, payload });
            expect(review.statusCode).toBe(409);
            expect(review.json()).toMatchObject({ error: "managed_resources_review_required", resources: [{ managedId: managed.id,
                recovery: { reference: "native-bootstrap" }, resource: { value: { id: "native-bootstrap" } } }] });
            expect(JSON.stringify(review.json())).not.toContain("private-bootstrap-value");
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).not.toBeNull();
            const removed = await app.inject({ method: "POST", url: "/v1/account/saved-secrets/resources/delete",
                headers: { "x-test-user-id": owner.id }, payload: { ...payload, managedResourceDispositions: [{
                    managedId: managed.id, expectedIntentRevision: 0, responsibility: "manual",
                    expectedAllocation: 'bound', expectedResource: { contributionRef: provider, schemaVersion: 1, value: { id: 'native-bootstrap' } },
                    expectedRecovery: { reference: 'native-bootstrap', reason: 'manual_recovery' },
                }] } });
            expect(removed.statusCode).toBe(200);
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } })).toMatchObject({ allocation: "bound" });
        } finally {
            await app.close();
        }
    });

    it("projects the exact resource id through the authenticated HTTP schema", async () => {
        const owner = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const resourceId = "resource_route_identity";
        const created = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId,
            displayName: "Shared API key",
            kind: "apiKey",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared API key", kind: "apiKey", value: "provider-secret" },
            },
        }));
        expect(created.ok).toBe(true);

        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();

        try {
            const response = await app.inject({
                method: "GET",
                url: "/v1/account/saved-secrets/resources/materials",
                headers: { "x-test-user-id": owner.id },
            });
            expect(response.statusCode).toBe(200);
            const parsed = SavedSecretResourceMaterialsResponseV1Schema.parse(response.json());
            expect(parsed.resources).toEqual([
                expect.objectContaining({
                    resourceId,
                    entry: expect.objectContaining({ ref: formatSharedSavedSecretRefV1(resourceId) }),
                }),
            ]);
        } finally {
            await app.close();
        }
    });

    it("returns owner-repairable and recipient-safe corrupt rows without blanking healthy catalog siblings", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_route_healthy_sibling",
            displayName: "Healthy sibling",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Healthy sibling", kind: "token", value: "healthy-secret" },
            },
            accountGrants: [recipient.id],
        }));
        const malformedResourceId = ` ${"malformed-route-id".repeat(10)}`;
        await db.savedSecretResource.create({
            data: {
                id: malformedResourceId,
                ownerAccountId: owner.id,
                displayName: "Unsafe retained metadata",
                kind: "token",
                encryptionMode: "plain",
                revision: 4,
                storedContent: "malformed-at-rest-container",
                accountGrants: {
                    create: { accountId: recipient.id, createdByAccountId: owner.id },
                },
            },
        });

        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        try {
            for (const [accountId, relationship] of [[recipient.id, "recipient"], [owner.id, "owner"]] as const) {
                const listResponse = await app.inject({
                    method: "GET",
                    url: "/v1/account/saved-secrets/resources",
                    headers: { "x-test-user-id": accountId },
                });
                expect(listResponse.statusCode).toBe(200);
                const list = SharedSavedSecretListOutputV1Schema.parse(listResponse.json());
                expect(list.resources).toHaveLength(2);
                const corruptListRow = list.resources.find((row) => row.materialStatus === "resource_corrupt");
                expect(corruptListRow).toEqual(relationship === "owner"
                    ? {
                        materialStatus: "resource_corrupt",
                        relationship: "owner",
                        repair: {
                            kind: "delete_resource",
                            resourceId: malformedResourceId,
                            expectedRevision: 4,
                        },
                    }
                    : { materialStatus: "resource_corrupt", relationship: "recipient", repair: null });

                const materialsResponse = await app.inject({
                    method: "GET",
                    url: "/v1/account/saved-secrets/resources/materials",
                    headers: { "x-test-user-id": accountId },
                });
                expect(materialsResponse.statusCode).toBe(200);
                const materials = SavedSecretResourceMaterialsResponseV1Schema.parse(materialsResponse.json());
                expect(materials.resources).toHaveLength(2);
                const corruptMaterial = materials.resources.find((row) => row.entry.materialStatus === "resource_corrupt");
                expect(corruptMaterial).toEqual({ entry: corruptListRow });
                if (relationship === "recipient") {
                    expect(JSON.stringify(corruptMaterial)).not.toContain(malformedResourceId);
                    expect(JSON.stringify(corruptMaterial)).not.toContain("Unsafe retained metadata");
                }
            }

            const deleteResponse = await app.inject({
                method: "POST",
                url: "/v1/account/saved-secrets/resources/delete",
                headers: { "x-test-user-id": owner.id },
                payload: { resourceId: malformedResourceId, expectedRevision: 4, expectedSettingsVersion: 0,
                    referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } },
            });
            expect(deleteResponse.statusCode).toBe(200);
            expect(await db.savedSecretResource.findUnique({ where: { id: malformedResourceId } })).toBeNull();
        } finally {
            await app.close();
        }
    });

    it("delivers healthy material beside a row whose stored envelope cannot be parsed", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        for (const resourceId of ["resource_route_damaged_envelope", "resource_route_intact_envelope"]) {
            const created = await inTx((tx) => createSavedSecretResourceInTx(tx, {
                accountId: owner.id,
                resourceId,
                displayName: resourceId,
                kind: "token",
                encryptionMode: "e2ee",
                storedContent: sealTestResource(resourceId),
                keyEnvelopes: [{
                    recipientAccountId: owner.id,
                    encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                    recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
                }],
            }));
            expect(created.ok).toBe(true);
        }
        await db.savedSecretResourceKeyEnvelope.update({
            where: {
                resourceId_recipientAccountId: {
                    resourceId: "resource_route_damaged_envelope",
                    recipientAccountId: owner.id,
                },
            },
            data: { encryptedDataKey: Buffer.from([1, 2, 3]) },
        });

        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({
                method: "GET",
                url: "/v1/account/saved-secrets/resources/materials",
                headers: { "x-test-user-id": owner.id },
            });
            expect(response.statusCode).toBe(200);
            const materials = SavedSecretResourceMaterialsResponseV1Schema.parse(response.json());
            const damaged = materials.resources.find((row) => "resourceId" in row
                && row.resourceId === "resource_route_damaged_envelope");
            const intact = materials.resources.find((row) => "resourceId" in row
                && row.resourceId === "resource_route_intact_envelope");
            expect(damaged).toEqual(expect.objectContaining({
                entry: expect.objectContaining({ materialStatus: "update_required" }),
                recipientEnvelope: null,
            }));
            expect(intact).toEqual(expect.objectContaining({
                entry: expect.objectContaining({ materialStatus: "ready" }),
                recipientEnvelope: expect.objectContaining({
                    recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
                }),
            }));
        } finally {
            await app.close();
        }
    });

    it("promotes one Saved Secret, publishes its AccountChange, hydrates it over HTTP, and serves real CLI consumers", async () => {
        const token = "saved-secret-composed-token";
        const resourceId = "resource_promoted_composed";
        const sharedRef = formatSharedSavedSecretRefV1(resourceId);
        const personalSecretId = "personal_secret_before_promotion";
        const voiceContribution = { pluginId: "happier.voice.test", localId: "speech" } as const;
        const personalSettings = {
            secrets: [{
                id: personalSecretId,
                name: "Promoted API key",
                kind: "apiKey",
                encryptedValue: { _isSecretValue: true, value: "shared-provider-secret" },
                createdAt: 1,
                updatedAt: 7,
            }],
            secretBindingsByProfileId: {
                shared: { SHARED_API_KEY: personalSecretId },
            },
            providerSettingsV1: ProviderSettingsV1Schema.parse({
                ...DEFAULT_PROVIDER_SETTINGS_V1,
                connections: [{
                    v: 1,
                    id: "pc_shared",
                    source: { kind: "contribution", contributionKey: "happier.provider.test/main" },
                    role: "default",
                    displayName: "Shared Provider",
                    displayNameMode: "automatic",
                    revision: 0,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                secretBindingsByConnectionId: {
                    pc_shared: { account: { apiKey: personalSecretId }, byMachineId: {} },
                },
            }),
            voiceSettingsV1: {
                credentialBindings: [{
                    contribution: voiceContribution,
                    credentialSlotId: "api_key",
                    credentialSource: { kind: "savedSecret" },
                    credentialBindings: { account: { api_key: personalSecretId } },
                }],
            },
        };
        const promotedSettings = promotePersonalSavedSecretReference(personalSettings, {
            secretId: personalSecretId,
            expectedUpdatedAt: 7,
            sharedSecretRef: sharedRef,
        }).settings;
        const owner = await db.account.create({
            data: {
                encryptionMode: "plain",
                settingsVersion: 1,
                settings: JSON.stringify({ t: "plain", v: personalSettings }),
            },
            select: { id: true },
        });
        const promoted = await inTx((tx) => promoteSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId,
            displayName: "Promoted API key",
            kind: "apiKey",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Promoted API key", kind: "apiKey", value: "shared-provider-secret" },
            },
            expectedSettingsVersion: 1,
            nextSettings: { t: "plain", v: promotedSettings },
            referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
            profileMutations: [],
        }));
        expect(promoted).toEqual({ ok: true, value: { resourceId, settingsVersion: 2 } });
        await expect(db.accountChange.findFirst({
            where: { kind: "savedSecretResource", entityId: resourceId },
            select: { accountId: true },
        })).resolves.toEqual({ accountId: owner.id });

        const app = createAuthenticatedTestApp();
        app.addHook("onRequest", async (request: FastifyRequest) => {
            request.headers["x-test-user-id"] = owner.id;
        });
        registerSavedSecretResourceRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerAccountSettingsRoutes(app);
        registerAccountSettingsHistoryRoutes(app);
        registerConnectedAccountConfigurationRowsRoutes(app);
        await app.listen({ host: "127.0.0.1", port: 0 });

        const activeSnapshot = await importCliTestModule<{
            setActiveAccountSettingsSnapshot(input: unknown): void;
            getActiveAccountSettingsSnapshot(): Readonly<{
                settings: Readonly<Record<string, unknown>>;
                savedSecretResources?: readonly unknown[];
            }> | null;
            resetActiveAccountSettingsSnapshotForTests(): void;
        }>("../../../../../../cli/src/settings/accountSettings/activeAccountSettingsSnapshot");
        try {
            const address = app.server.address();
            if (!address || typeof address === "string") throw new Error("expected TCP test address");
            const { resolveAccountSettingsScopeKeyForToken } = await importCliTestModule<{
                resolveAccountSettingsScopeKeyForToken(token: string): string;
            }>("../../../../../../cli/src/settings/accountSettings/accountSettingsScopeKey");
            const { runWithServerHttpBaseUrl } = await importCliTestModule<{
                runWithServerHttpBaseUrl<T>(baseUrl: string, operation: () => Promise<T>): Promise<T>;
            }>("../../../../../../cli/src/api/client/serverHttpBaseUrl");
            const { hydrateSavedSecretCatalog } = await importCliTestModule<{
                hydrateSavedSecretCatalog(input: Readonly<{
                    token: string;
                    serverFeatures: FeaturesResponse | null;
                }>): Promise<void>;
            }>("../../../../../../cli/src/settings/secrets/hydrateSavedSecretCatalog");
            const { refreshActiveConnectedAccountCatalog } = await importCliTestModule<{
                refreshActiveConnectedAccountCatalog(input: Readonly<{
                    credentials: Readonly<{ token: string; encryption: null }>;
                    key: "purposes";
                }>): Promise<unknown>;
            }>("../../../../../../cli/src/settings/connectedAccounts/hydrateConnectedAccountCatalog");

            activeSnapshot.setActiveAccountSettingsSnapshot({
                source: "network",
                scopeKey: resolveAccountSettingsScopeKeyForToken(token),
                settingsVersion: 2,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                settings: promotedSettings,
            });
            await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
                // Voice source selection needs the opened purpose authority, not
                // an assumed empty facet. The canonical owner admits absence
                // from Home settings, creates the row, and re-reads it over HTTP.
                await expect(refreshActiveConnectedAccountCatalog({
                    credentials: { token, encryption: null },
                    key: "purposes",
                })).resolves.toMatchObject({
                    status: "ready",
                    record: { key: "purposes" },
                    revision: expect.any(Number),
                });
                await hydrateSavedSecretCatalog({
                    token,
                    // The catalog is Teams-gated at its own owner; the harness runs
                    // with HAPPIER_FEATURE_TEAMS__ENABLED so the Home answers the same bit.
                    serverFeatures: FeaturesResponseSchema.parse({
                        features: { teams: { enabled: true } },
                        capabilities: {},
                    }),
                });
            });
            const snapshot = activeSnapshot.getActiveAccountSettingsSnapshot();
            expect(snapshot?.savedSecretResources).toHaveLength(1);
            if (!snapshot) throw new Error("expected hydrated Account snapshot");

            const { createSavedSecretMaterializerV1 } = await importCliTestModule<{
                createSavedSecretMaterializerV1(input: Readonly<{
                    accountSettings: unknown;
                    settingsSecretsReadKeys: readonly Uint8Array[];
                }>): Readonly<{
                    inspect(ref: string): Readonly<{ status: string; fingerprint?: string }>;
                }>;
            }>("../../../../../../cli/src/settings/secrets/savedSecretCatalog");
            const materializer = createSavedSecretMaterializerV1({
                accountSettings: snapshot.settings,
                settingsSecretsReadKeys: [],
            });
            const inspected = materializer.inspect(sharedRef);
            expect(inspected.status).toBe("ready");
            if (!inspected.fingerprint) throw new Error("expected hydrated material fingerprint");

            const { resolveForegroundProfileSavedSecretEnvironment } = await importCliTestModule<{
                resolveForegroundProfileSavedSecretEnvironment(input: unknown): Readonly<Record<string, string>>;
            }>("../../../../../../cli/src/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment");
            const profile = AIBackendProfileSchema.parse({
                id: "shared",
                name: "Shared",
                envVarRequirements: [{ name: "SHARED_API_KEY", kind: "secret", required: true }],
                environmentVariables: [],
                defaultPermissionModeByTargetKey: {},
                compatibilityByTargetKey: {},
                isBuiltIn: false,
                createdAt: 1,
                updatedAt: 1,
                version: "1.0.0",
            });
            expect(resolveForegroundProfileSavedSecretEnvironment({
                profile,
                accountSettings: snapshot.settings,
                settingsSecretsReadKeys: [],
                foregroundSatisfiedSecretRequirementNames: [],
            })).toEqual({ SHARED_API_KEY: "shared-provider-secret" });

            const { resolveValueRefPlaintext } = await importCliTestModule<{
                resolveValueRefPlaintext(input: unknown): Readonly<{ status: string; value?: string }>;
            }>("../../../../../../cli/src/settings/valueRefs/resolveValueRefPlaintext");
            expect(resolveValueRefPlaintext({
                valueRef: { t: "savedSecret", secretId: sharedRef },
                savedSecretMaterializer: materializer,
                processEnv: {},
            })).toEqual({ status: "ready", value: "shared-provider-secret" });

            const { materializeConfiguredAcpEnvironment } = await importCliTestModule<{
                materializeConfiguredAcpEnvironment(input: unknown): Record<string, string>;
            }>("../../../../../../cli/src/agent/acp/catalog/configured/materializeEnvironment");
            expect(materializeConfiguredAcpEnvironment({
                backend: { env: { ACP_TOKEN: { t: "savedSecret", secretId: sharedRef } } },
                accountSettings: snapshot.settings,
                credentials: { token, encryption: null },
                processEnv: {},
            })).toEqual({ ACP_TOKEN: "shared-provider-secret" });

            const provider = await importCliTestModule<{
                resolveProviderCredentialReference(input: unknown): Readonly<{
                    ok: boolean;
                    reference?: unknown;
                }>;
                resolveProviderCredentialPlaintext(input: unknown): unknown;
            }>("../../../../../../cli/src/providers/spawn/credentials");
            const providerReference = provider.resolveProviderCredentialReference({
                providerSettings: snapshot.settings.providerSettingsV1,
                accountSettings: snapshot.settings,
                connectionId: "pc_shared",
                machineId: "machine",
                credentialSlotId: "apiKey",
                required: true,
            });
            expect(providerReference).toMatchObject({
                ok: true,
                reference: { kind: "apiKey", secretId: sharedRef },
            });
            if (!providerReference.ok || !providerReference.reference) throw new Error("expected Provider credential reference");
            expect(provider.resolveProviderCredentialPlaintext({
                reference: providerReference.reference,
                accountSettings: snapshot.settings,
                settingsSecretsReadKeys: [],
                connectionId: "connection",
                machineId: "machine",
            })).toEqual({ ok: true, credential: { kind: "apiKey", value: "shared-provider-secret" } });

            const { createActiveAccountSettingsConnectedAccountSecrets } = await importCliTestModule<{
                createActiveAccountSettingsConnectedAccountSecrets(input: Readonly<{ expectedScopeKey: string }>): Readonly<{
                    has(ref: string): Promise<boolean>;
                    read(ref: string): Promise<string | null>;
                }>;
            }>("../../../../../../cli/src/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence");
            const connectedSecrets = createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKeyForToken(token) });
            await expect(connectedSecrets.has(sharedRef)).resolves.toBe(true);
            await expect(connectedSecrets.read(sharedRef)).resolves.toBe("shared-provider-secret");

            const { createVoiceCredentialResolver } = await importCliTestModule<{
                createVoiceCredentialResolver(input: Readonly<{
                    machineId: string | null;
                    refreshForOperation?: (input: Readonly<{
                        expectedScopeKey: string;
                        references?: readonly Readonly<{ ref: string; revision?: number }>[];
                    }>) => Promise<unknown>;
                }>): Readonly<{
                    withSecret<T>(input: Readonly<{ identity: unknown; use(secret: string): Promise<T> }>): Promise<T>;
                }>;
            }>("../../../../../../cli/src/daemon/voice/credentials/resolver");
            const voiceIdentity = VoiceCredentialBindingIdentityV1Schema.parse({
                contribution: voiceContribution,
                credentialSlotId: "api_key",
                purpose: { consumer: voiceContribution, purpose: "voice.client-auth" },
            });
            // A new Voice operation is admitted against Home-current material
            // before any plaintext, so this leg performs a real second read of
            // the live materials route. The daemon reads its stored credential
            // inside the admission owner; this server-side process holds none,
            // so the test supplies the same token it hydrated with and the
            // canonical hydration still does the Home round trip.
            const admittedReferences: string[] = [];
            const voiceResolver = createVoiceCredentialResolver({
                machineId: null,
                refreshForOperation: async ({ references }) => {
                    for (const reference of references ?? []) admittedReferences.push(reference.ref);
                    await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
                        await hydrateSavedSecretCatalog({
                            token,
                            serverFeatures: FeaturesResponseSchema.parse({
                                features: { teams: { enabled: true } },
                                capabilities: {},
                            }),
                        });
                    });
                    return activeSnapshot.getActiveAccountSettingsSnapshot();
                },
            });
            await expect(voiceResolver.withSecret({
                identity: voiceIdentity,
                use: async (secret: string) => secret,
            })).resolves.toBe("shared-provider-secret");
            expect(admittedReferences).toEqual([sharedRef]);
        } finally {
            activeSnapshot.resetActiveAccountSettingsSnapshotForTests();
            await app.close();
        }
    });
    it("promotes a restricted Team audience for a caller whose request credential qualifies", async () => {
        const HOME_OFFERS_EMAIL_PASSWORD = {
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        };
        for (const [key, value] of Object.entries(HOME_OFFERS_EMAIL_PASSWORD)) process.env[key] = value;
        const owner = await db.account.create({
            data: {
                encryptionMode: "plain",
                settingsVersion: 1,
                settings: JSON.stringify({ t: "plain", v: { secrets: [] } }),
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: { accountId: owner.id, provider: "email", providerUserId: "promote@example.test", profile: {} },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: owner.id,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("promote password factor")),
                },
            },
        });
        const team = await db.team.create({
            data: {
                name: "Promote restricted",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "email_password" }],
                },
            },
            select: { id: true },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });

        const body = (resourceId: string) => SharedSavedSecretPromoteInputV1Schema.parse({
            resourceId,
            displayName: "Promoted team key",
            kind: "apiKey" as const,
            encryptionMode: "plain" as const,
            storedContent: {
                t: "plain" as const,
                v: { v: 1 as const, name: "Promoted team key", kind: "apiKey" as const, value: "promoted-value" },
            },
            teamGrants: [team.id],
            expectedSettingsVersion: 1,
            nextSettings: { t: "plain" as const, v: { secrets: [] } },
            referenceCensus: { accountMode: 'plain', profileTransferRevision: 'absent',
                profiles: { referenceGuardRevision: 'absent', rows: [] } },
        });

        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        try {
            const url = homeDomainActionPathForMethod("secrets.shared.promote", "POST");
            // The request proves the Team's accepted method, exactly as the
            // create and grants-set routes already forward it.
            const qualified = await app.inject({
                method: "POST",
                url,
                headers: {
                    "x-test-user-id": owner.id,
                    "x-test-authentication-evidence": JSON.stringify([{ kind: "home_method", methodId: "email_password" }]),
                },
                payload: body("resource_promote_qualified"),
            });
            expect({ status: qualified.statusCode, body: qualified.json() }).toEqual({
                status: 200,
                body: { resourceId: "resource_promote_qualified", settingsVersion: 2 },
            });
            expect(await db.savedSecretTeamGrant.count({ where: { resourceId: "resource_promote_qualified" } })).toBe(1);

            // The same request without that evidence still fails closed and
            // writes nothing.
            const currentAccount = await db.account.findUniqueOrThrow({
                where: { id: owner.id }, select: { settingsVersion: true, settings: true },
            });
            const currentGuard = await inTx(tx => readProfileReferenceGuardInTx(tx, { accountId: owner.id }));
            if (currentGuard.status !== 'ready') throw new Error('Expected a current reference census');
            const unqualifiedBody = body("resource_promote_unqualified");
            const unqualified = await app.inject({
                method: "POST",
                url,
                headers: { "x-test-user-id": owner.id },
                payload: { ...unqualifiedBody, expectedSettingsVersion: currentAccount.settingsVersion,
                    referenceCensus: { ...unqualifiedBody.referenceCensus,
                        profiles: { ...unqualifiedBody.referenceCensus.profiles, referenceGuardRevision: currentGuard.revision } } },
            });
            expect({ status: unqualified.statusCode, body: unqualified.json() }).toEqual({
                status: 403,
                body: { error: "forbidden" },
            });
            expect(await db.savedSecretResource.count({ where: { id: "resource_promote_unqualified" } })).toBe(0);
            await expect(db.account.findUniqueOrThrow({
                where: { id: owner.id }, select: { settingsVersion: true, settings: true },
            })).resolves.toEqual(currentAccount);
            await expect(inTx(tx => readProfileReferenceGuardInTx(tx, { accountId: owner.id })))
                .resolves.toEqual(currentGuard);
        } finally {
            await app.close();
        }
    });

    it("carries an explicit mode conversion through the strict update route in both directions", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const resourceId = "resource_route_mode_conversion";
        const ownerEnvelope = {
            recipientAccountId: owner.id,
            encryptedDataKey: Buffer.from(sealTestDataKey(ownerMaterial.contentPublicKey)).toString("base64"),
            recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
        };
        const created = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId,
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource(resourceId),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }],
        }));
        expect(created.ok).toBe(true);

        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        await app.ready();
        const url = homeDomainActionPathForMethod("secrets.shared.update", "POST");
        const readOwnerMaterial = async () => {
            const response = await app.inject({
                method: "GET",
                url: "/v1/account/saved-secrets/resources/materials",
                headers: { "x-test-user-id": owner.id },
            });
            expect(response.statusCode).toBe(200);
            return SavedSecretResourceMaterialsResponseV1Schema.parse(response.json()).resources[0];
        };
        const toPlainPayload = {
            resourceId,
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
        };
        try {
            // A Home whose storage policy requires E2EE refuses the conversion
            // into Plain and keeps the resource exactly as it was.
            harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee" });
            const refusedByPolicy = await app.inject({
                method: "POST",
                url,
                headers: { "x-test-user-id": owner.id },
                payload: toPlainPayload,
            });
            expect({ status: refusedByPolicy.statusCode, body: refusedByPolicy.json() }).toEqual({
                status: 403,
                body: { error: "forbidden" },
            });
            expect(await readOwnerMaterial()).toEqual(expect.objectContaining({
                entry: expect.objectContaining({ encryptionMode: "e2ee", revision: 1 }),
            }));

            harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
            const toPlain = await app.inject({
                method: "POST",
                url,
                headers: { "x-test-user-id": owner.id },
                payload: toPlainPayload,
            });
            expect({ status: toPlain.statusCode, body: toPlain.json() }).toEqual({
                status: 200,
                body: { resourceId, revision: 2 },
            });
            expect(await readOwnerMaterial()).toEqual(expect.objectContaining({
                resourceId,
                entry: expect.objectContaining({ encryptionMode: "plain", materialStatus: "ready", revision: 2 }),
            }));

            const withoutOwnerEnvelope = await app.inject({
                method: "POST",
                url,
                headers: { "x-test-user-id": owner.id },
                payload: {
                    resourceId,
                    expectedRevision: 2,
                    displayName: "Shared token",
                    kind: "token",
                    toMode: "e2ee",
                    storedContent: sealTestResource(resourceId),
                },
            });
            expect({ status: withoutOwnerEnvelope.statusCode, body: withoutOwnerEnvelope.json() }).toEqual({
                status: 400,
                body: { error: "invalid_resource" },
            });

            const toE2ee = await app.inject({
                method: "POST",
                url,
                headers: { "x-test-user-id": owner.id },
                payload: {
                    resourceId,
                    expectedRevision: 2,
                    displayName: "Shared token",
                    kind: "token",
                    toMode: "e2ee",
                    storedContent: sealTestResource(resourceId),
                    keyEnvelopes: [ownerEnvelope],
                },
            });
            expect({ status: toE2ee.statusCode, body: toE2ee.json() }).toEqual({
                status: 200,
                body: { resourceId, revision: 3 },
            });
            expect(await readOwnerMaterial()).toEqual(expect.objectContaining({
                resourceId,
                entry: expect.objectContaining({ encryptionMode: "e2ee", materialStatus: "ready", revision: 3 }),
                recipientEnvelope: expect.objectContaining({
                    recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
                }),
            }));
        } finally {
            await app.close();
        }
    });

});
