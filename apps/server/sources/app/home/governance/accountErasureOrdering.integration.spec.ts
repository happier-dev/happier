import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { join } from "node:path";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

import type { Fastify as AppFastify } from "@/app/api/types";
import { publishPublicProfile } from '@/app/account/profile/publicProfilePublish';
import { readPublicProfile } from '@/app/account/profile/publicProfileRead';
import { publicProfileServerDependencies } from '@/app/account/profile/publicProfileDependencies';
import { startSocket } from "@/app/api/socket";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { homeGovernanceRoutes } from "@/app/api/routes/home/homeGovernanceRoutes";
import { registerAccountErasureRoute } from "@/app/api/routes/auth/registerAccountErasureRoute";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { createLocalPrivateFilesBackend, resolveLocalPrivateFilesDir } from "@/storage/privateFiles/privateFilesLocal";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";
import { TEAM_CHANGE_ENTITY_ID } from "@/app/teams/teamChanges";
import { ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE } from "@/app/encryption/accountEncryptionTransitionCoordinator";

// Object storage is the one genuine system boundary here. Every Home
// governance rule, transaction ordering, lifecycle transition and credential
// revocation below runs for real, so the assertions describe the actual
// erasure contract rather than a rehearsal of it.
const blobCalls: Array<Readonly<{ path: string; accountStatusAtCall: string | null }>> = [];
const privateBlobCalls: string[] = [];
const privateBlobPaths = new Map<string, string>();
let failBlobDeletion = false;
let failPrivateBlobDeletion = false;
/** Runs between Phase A's commit and Phase C, where object storage runs. */
let duringBlobDeletion: (() => Promise<void>) | null = null;

vi.mock("@/storage/blob/files", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/storage/blob/files")>()),
    deletePublicFile: vi.fn(async (path: string) => {
        // Read the lifecycle state the erasure has already committed. Phase A
        // must have retired the Account before any irreversible delete.
        const account = await db.account.findFirst({
            where: { UploadedFile: { some: { path } } },
            select: { status: true },
        });
        blobCalls.push({ path, accountStatusAtCall: account?.status ?? null });
        if (duringBlobDeletion) await duringBlobDeletion();
        if (failBlobDeletion) throw new Error("object store unavailable");
    }),
}));

// Fail only the physical filesystem operation; pet deletion and path validation run for real.
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
        const objectKey = typeof args[0] === "string" ? privateBlobPaths.get(args[0]) : undefined;
        if (objectKey) {
            privateBlobCalls.push(objectKey);
            if (failPrivateBlobDeletion) throw new Error("private object store unavailable");
        }
        return actual.rm(...args);
    } };
});

const { deleteAccountForErasure } = await import("@/app/plugins/data/accountDataErase");
const { auth } = await import("@/app/auth/auth");

let harness: LightSqliteHarness;
let sequence = 0;

async function createAccountWithBlob(
    options: Readonly<{ homeRole: "owner" | "admin" | "member" }>,
): Promise<Readonly<{ accountId: string; path: string }>> {
    sequence += 1;
    const path = `erasure-ordering-${sequence}.png`;
    const account = await db.account.create({
        data: { publicKey: null, encryptionMode: "plain", homeRole: options.homeRole },
        select: { id: true },
    });
    await db.uploadedFile.create({ data: { accountId: account.id, path } });
    return { accountId: account.id, path };
}

async function createPrivatePetAsset(accountId: string): Promise<Readonly<{ assetId: string; objectKey: string }>> {
    sequence += 1;
    const petPackageId = `erasure-pet-${sequence}`;
    const assetId = `${petPackageId}-asset`;
    const objectKey = `private/accounts/${accountId}/pets/${petPackageId}/sheet.webp`;
    const rootDir = resolveLocalPrivateFilesDir();
    const backend = createLocalPrivateFilesBackend({ rootDir });
    await backend.writePrivateFile(objectKey, new Uint8Array([1]));
    privateBlobPaths.set(join(rootDir, objectKey), objectKey);
    await db.accountPetPackage.create({
        data: {
            id: petPackageId,
            accountId,
            packageFormat: "codexAtlasV1",
            contentMode: "plain",
            manifest: { id: petPackageId },
            digest: `sha256:${petPackageId}`,
            sizeBytes: 1,
            origin: { kind: "manualImport" },
        },
    });
    await db.accountPetAsset.create({
        data: {
            id: assetId,
            accountId,
            petPackageId,
            contentMode: "plain",
            storageKind: "privateFile",
            objectKey,
            byteLength: 1,
            mediaType: "image/webp",
            digest: `sha256:${petPackageId}-asset`,
        },
    });
    return { assetId, objectKey };
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-erasure-ordering-",
        initAuth: true,
        initEncrypt: true,
        initFiles: true,
    });
}, 120_000);
afterAll(async () => await harness.close());
afterEach(async () => {
    blobCalls.length = 0;
    privateBlobCalls.length = 0;
    privateBlobPaths.clear();
    failBlobDeletion = false;
    failPrivateBlobDeletion = false;
    duringBlobDeletion = null;
    await db.uploadedFile.deleteMany({});
    await db.team.deleteMany({});
    await db.account.deleteMany({});
});

describe("Account erasure ordering against Home ownership", () => {
    it("reports pending completion for a managed resource discovered after retirement and preserves Home-owner review", async () => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "member" });
        const provider = { pluginId: "fixture.compute", localId: "cloud" };
        const recovery = { reference: "purchase-in-progress", reason: "manual_recovery" };
        const resource = { contributionRef: provider, schemaVersion: 1, value: { id: "paid-after-review" } };
        const boundRecovery = { reference: "paid-after-review", reason: "manual_recovery" };
        const managed = await db.managedMachine.create({ data: {
            homeId: "late-native-home", custodianAccountId: accountId,
            controllerMachineId: "late-controller", controllerInstallationId: "late-installation",
            admittedActionRequestId: `late-native-${sequence}`, admittedInput: {},
            launch: { provider, schemaVersion: 1, name: "Purchasing", choices: {} },
            allocation: "may-exist", recovery, retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
        } });
        const disposition = { managedId: managed.id, expectedIntentRevision: 0, responsibility: "manual",
            expectedAllocation: "may-exist", expectedRecovery: recovery };
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        enableAuthentication(typed);
        startSocket(typed);
        homeGovernanceRoutes(typed);
        registerAccountErasureRoute(typed);
        const ownerToken = await auth.createToken(ownerId, undefined, { kind: "account", authority: "present_user" });
        const selfToken = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
        // A real provider can report its paid resource while object storage is
        // deleting blobs. Persist that boundary update through the real DB.
        duringBlobDeletion = async () => {
            await db.managedMachine.update({ where: { id: managed.id }, data: {
                allocation: "bound", resource, recovery: boundRecovery,
            } });
        };
        try {
            const response = await app.inject({ method: "POST", url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${selfToken}` },
                payload: { confirmation: "DELETE", managedResourceDispositions: [disposition] } });
            expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, tokenEpoch: true } }))
                .toEqual({ status: "disabled", tokenEpoch: 1 });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } }))
                .toMatchObject({ allocation: "bound", resource, recovery: boundRecovery });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "disabled_pending_completion" });
            duringBlobDeletion = null;
            const review = await app.inject({ method: "POST", url: "/v1/home/accounts/delete",
                headers: { authorization: `Bearer ${ownerToken}` },
                payload: { accountId, managedResourceDispositions: [disposition] } });
            expect(review.statusCode).toBe(409);
            expect(review.json()).toMatchObject({ error: "account_erasure_managed_resources_review_required",
                resources: [{ managedId: managed.id, allocation: "bound", resource, recovery: boundRecovery }] });
            expect(blobCalls).toEqual([{ path, accountStatusAtCall: "disabled" }]);
            const completed = await app.inject({ method: "POST", url: "/v1/home/accounts/delete",
                headers: { authorization: `Bearer ${ownerToken}` }, payload: { accountId, managedResourceDispositions: [{
                    ...disposition, expectedAllocation: "bound", expectedResource: resource, expectedRecovery: boundRecovery,
                }] } });
            expect(completed.statusCode).toBe(200);
            expect(completed.json()).toEqual({ status: "deleted" });
            expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
            expect(await db.managedMachine.findUnique({ where: { id: managed.id } })).toBeNull();
            expect(await db.account.findUniqueOrThrow({ where: { id: ownerId }, select: { status: true, homeRole: true } }))
                .toEqual({ status: "active", homeRole: "owner" });
        } finally {
            duringBlobDeletion = null;
            await app.close();
            await db.managedMachine.deleteMany({ where: { id: managed.id } });
        }
    });

    it.each([
        { route: "home", failure: "deadline" }, { route: "self", failure: "deadline" },
        { route: "home", failure: "unclassified" }, { route: "self", failure: "unclassified" },
    ] as const)("reports committed retirement only for classified Phase C failures ($route / $failure), then resumes through Home administration", async ({ route, failure }) => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "member" });
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        enableAuthentication(typed);
        startSocket(typed);
        homeGovernanceRoutes(typed);
        registerAccountErasureRoute(typed);
        const ownerToken = await auth.createToken(ownerId, undefined, { kind: "account", authority: "present_user" });
        const selfToken = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
        const transaction = db.$transaction;
        // The database driver is the failure boundary. Real Phase A commits,
        // then the real Phase C callback rolls back at its terminal DELETE.
        duringBlobDeletion = async () => {
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== "account") return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.account, { get(delegate, method, delegateReceiver) {
                        if (method !== "delete") return Reflect.get(delegate, method, delegateReceiver);
                        return async () => {
                            if (failure === "unclassified") throw new Error("Unexpected database callback failure");
                            throw Object.assign(new Error("A query cannot be executed on an expired transaction"), { code: "P2028" });
                        };
                    } });
                } })), ...args.slice(1)]);
            } });
        };
        try {
            const response = await app.inject({
                method: "POST",
                url: route === "home" ? "/v1/home/accounts/delete" : "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${route === "home" ? ownerToken : selfToken}` },
                payload: route === "home" ? { accountId } : { confirmation: "DELETE" },
            });
            expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, tokenEpoch: true } }))
                .toEqual({ status: "disabled", tokenEpoch: 1 });
            expect(await db.uploadedFile.count({ where: { accountId } })).toBe(1);
            expect(response.statusCode).toBe(failure === "deadline" ? 200 : 500);
            if (failure === "deadline") expect(response.json()).toEqual({ status: "disabled_pending_completion" });
            db.$transaction = transaction;
            duringBlobDeletion = null;
            for (const attempt of ["resume", "repeat"]) {
                const resumed = await app.inject({ method: "POST", url: "/v1/home/accounts/delete",
                    headers: { authorization: `Bearer ${ownerToken}` }, payload: { accountId } });
                expect(resumed.statusCode, attempt).toBe(200);
                expect(resumed.json(), attempt).toEqual({ status: "deleted" });
            }
            expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
            expect(blobCalls).toEqual([{ path, accountStatusAtCall: "disabled" }, { path, accountStatusAtCall: "disabled" }]);
        } finally {
            db.$transaction = transaction;
            duringBlobDeletion = null;
            await app.close();
        }
    });

    it.each(["home", "self"] as const)("reports bounded encryption cleanup through the %s route before retirement or object deletion", async (route) => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "member" });
        const handle = `erasure_profile_${sequence}`;
        const profileEnv = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test',
            HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' };
        await db.account.update({ where: { id: accountId }, data: { username: handle } });
        expect((await publishPublicProfile(accountId, PublicProfilePublishBodyV1Schema.parse({
            policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, bio: true } },
            metadata: { bio: 'withdraw-before-blob-io' }, projectSelections: [],
            query: { population: 'public_eligible_personal', period: { startMs: 1, endMs: 2 }, timeZoneOffsetMinutes: 0 },
            snapshot: { v: 1, computedAtMs: 2, period: { startMs: 1, endMs: 2, timeZoneOffsetMinutes: 0 },
                coverage: { status: 'unavailable', method: 'unknown' }, fieldCoverage: {}, facts: {} },
            layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        }), profileEnv, publicProfileServerDependencies)).kind).toBe('updated');
        const publicationBefore = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId } });
        expect(publicationBefore.metadataJson).toContain('withdraw-before-blob-io');
        expect(await readPublicProfile(handle, profileEnv, publicProfileServerDependencies)).toMatchObject({ kind: 'published' });
        const transitionId = `erasure-transition-${sequence}`;
        await db.accountEncryptionTransition.create({ data: {
            id: transitionId,
            accountId,
            fromEncryptionMode: "plain",
            toEncryptionMode: "e2ee",
            sourceAccountVersion: 0,
            sourceSettingsVersion: 0,
            status: "authorized",
            activeAccountId: accountId,
            preparedAt: new Date(),
            expiresAt: new Date("2100-01-01T00:00:00.000Z"),
        } });
        // Persisted transition stages are a database boundary fixture. Use the
        // coordinator's real cleanup budget rather than a second test limit.
        const stageCount = ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize + 1;
        await db.accountEncryptionTransitionCollectionStage.createMany({ data: Array.from(
            { length: stageCount },
            (_, index) => ({
                transitionId,
                pluginId: "example.erasure",
                collectionId: "records",
                rowId: `staged-${index}`,
                sourceRevision: 1,
                sourceEnvelope: { t: "plain", v: {} },
                targetEnvelope: { t: "encrypted", c: "staged-target" },
                schemaVersion: 1,
                contractDigest: "A".repeat(43),
                sourceEncodedBytes: 2n,
                targetEncodedBytes: 13n,
            }),
        ) });

        // A rejected administrative request may not cancel the transition
        // merely because its actor and target identifiers coincide.
        await expect(deleteAccountForErasure({ accountId,
            actor: { kind: "home_administration", actorAccountId: accountId },
        })).resolves.toEqual({ status: "failed", code: "home_governance_forbidden" });
        expect(await db.accountEncryptionTransitionCollectionStage.count({ where: { transitionId } })).toBe(stageCount);

        const erase = () => deleteAccountForErasure({ accountId,
            actor: { kind: "home_administration", actorAccountId: ownerId },
        });
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        enableAuthentication(typed);
        startSocket(typed);
        homeGovernanceRoutes(typed);
        registerAccountErasureRoute(typed);
        const token = await auth.createToken(route === "home" ? ownerId : accountId, undefined, {
            kind: "account", authority: "present_user",
        });
        try {
            const response = await app.inject({
                method: "POST",
                url: route === "home" ? "/v1/home/accounts/delete" : "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${token}` },
                payload: route === "home" ? { accountId } : { confirmation: "DELETE" },
            });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "account_erasure_transition_cleanup_pending" });
        } finally {
            await app.close();
        }
        expect(blobCalls).toEqual([]);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true, tokenEpoch: true } }))
            .toEqual({ status: "active", tokenEpoch: 0 });
        expect(await db.accountEncryptionTransitionCollectionStage.count({ where: { transitionId } })).toBe(1);
        expect(await db.uploadedFile.count({ where: { accountId } })).toBe(1);
        expect(await db.accountPublicProfile.findUnique({ where: { accountId } })).toEqual(publicationBefore);
        expect(await readPublicProfile(handle, profileEnv, publicProfileServerDependencies)).toMatchObject({ kind: 'published' });

        let publicationAtBlobDeletion: unknown = 'object storage not called';
        let publicReadAtBlobDeletion: unknown = 'object storage not called';
        duringBlobDeletion = async () => {
            publicationAtBlobDeletion = await db.accountPublicProfile.findUnique({ where: { accountId } });
            publicReadAtBlobDeletion = await readPublicProfile(handle, profileEnv, publicProfileServerDependencies);
        };
        failBlobDeletion = true;
        await expect(erase()).resolves.toEqual({ status: "failed", code: "account_erasure_blob_delete_failed" });
        expect(publicationAtBlobDeletion).toBeNull();
        expect(publicReadAtBlobDeletion).toEqual({ kind: 'unavailable' });
        expect(await db.accountPublicProfile.findUnique({ where: { accountId } })).toBeNull();
        expect(await readPublicProfile(handle, profileEnv, publicProfileServerDependencies)).toEqual({ kind: 'unavailable' });
        expect(await db.accountEncryptionTransitionCollectionStage.count({ where: { transitionId } })).toBe(0);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } }))
            .toEqual({ status: "disabled" });
        failBlobDeletion = false;
        await expect(erase()).resolves.toEqual({ status: "deleted" });
        expect(blobCalls).toEqual([
            { path, accountStatusAtCall: "disabled" },
            { path, accountStatusAtCall: "disabled" },
        ]);
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
    });

    it("invalidates Team readers at retirement and again when retry removes the retained roster row", async () => {
        const { accountId: homeOwnerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole: "member" });
        const { accountId: viewerId } = await createAccountWithBlob({ homeRole: "member" });
        await db.team.create({ data: { name: "Erasure observers", memberships: { create: [
            { accountId, role: "member" }, { accountId: viewerId, role: "owner" },
        ] } } });
        await db.team.create({ data: { name: "Shared erasure observers", memberships: { create: [
            { accountId, role: "member" }, { accountId: viewerId, role: "owner" },
        ] } } });
        const viewerSeqBefore = (await db.account.findUniqueOrThrow({
            where: { id: viewerId }, select: { seq: true },
        })).seq;
        const change = () => db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: viewerId, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID,
        } } });
        failBlobDeletion = true;
        const erase = () => deleteAccountForErasure({ accountId,
            actor: { kind: "home_administration", actorAccountId: homeOwnerId },
        });
        expect(await erase()).toEqual({ status: "failed", code: "account_erasure_blob_delete_failed" });
        const retiredChange = await change();
        expect(retiredChange).toMatchObject({ hint: null, cursor: viewerSeqBefore + 1 });
        expect(await db.teamMembership.count({ where: { accountId } })).toBe(2);
        failBlobDeletion = false;
        expect(await erase()).toEqual({ status: "deleted" });
        const deletedChange = await change();
        expect(deletedChange?.cursor).toBe(retiredChange!.cursor + 1);
        expect(await db.teamMembership.count({ where: { accountId } })).toBe(0);
        expect(await erase()).toEqual({ status: "already-deleted" });
        expect(await change()).toEqual(deletedChange);
    });

    it("refuses the final active Home owner before any object is deleted", async () => {
        const { accountId } = await createAccountWithBlob({ homeRole: "owner" });

        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({
            status: "failed",
            code: "home_owner_transfer_required",
        });

        // The refusal must precede irreversible work, and it must not have
        // retired the Account it just refused to erase.
        expect(blobCalls).toEqual([]);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } }))
            .toEqual({ status: "active" });
        expect(await db.uploadedFile.count({ where: { accountId } })).toBe(1);
    });

    it("retires and revokes the Account before the first object delete, then completes deletion", async () => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "owner" });
        const pat = await auth.createApiToken({ accountId, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(accountId, "Before erasure") });

        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({ status: "deleted" });

        // Ordering is the contract: the Account was already terminally
        // inactive when the object store was first called, so it could not
        // have acquired a required ownership mid-erasure.
        expect(blobCalls).toEqual([{ path, accountStatusAtCall: "disabled" }]);
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
        await expect(auth.verifyPat(pat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });
    });

    it("explicitly closes and removes pending Runner activations before deleting their creator Account", async () => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole: "member" });
        await db.ephemeralRunnerActivation.createMany({
            data: ["pending", "closed"].map((state, index) => ({
                id: `erasure-runner-${state}-${sequence}`,
                creatorAccountId: accountId,
                creatorTokenEpoch: 0,
                draftId: `erasure-runner-draft-${state}-${sequence}`,
                sessionId: `erasure-runner-session-${state}-${sequence}`,
                machineId: `erasure-runner-machine-${state}-${sequence}`,
                state,
                workspacePolicy: "choose_on_endpoint",
                closeReason: state === "closed" ? "canceled" : null,
                homeServerIdentityId: "erasure-home",
                activationSigningPublicKey: `erasure-runner-key-${index}`,
                authoringCommitment: `erasure-runner-commitment-${index}`,
                artifact: {},
                endpointFactsRecipient: {},
            })),
        });
        const triggerName = "require_explicit_runner_activation_cleanup";
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            BEFORE DELETE ON "Account"
            FOR EACH ROW
            WHEN EXISTS (
                SELECT 1 FROM "EphemeralRunnerActivation"
                WHERE "creatorAccountId" = OLD."id"
            )
            BEGIN
                SELECT RAISE(ABORT, 'Runner activation cleanup must precede Account deletion');
            END
        `);

        try {
            await expect(deleteAccountForErasure({ accountId }))
                .resolves.toEqual({ status: "deleted" });
            expect(await db.ephemeralRunnerActivation.count({ where: { creatorAccountId: accountId } }))
                .toBe(0);
        } finally {
            await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}"`);
            await db.ephemeralRunnerActivation.deleteMany({ where: { creatorAccountId: accountId } });
        }
    });

    it("leaves a failed erasure terminally retired rather than deleted or resurrected", async () => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole: "owner" });
        failBlobDeletion = true;
        const ownerSeqBefore = (await db.account.findUniqueOrThrow({
            where: { id: ownerId },
            select: { seq: true },
        })).seq;

        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({
            status: "failed",
            code: "account_erasure_blob_delete_failed",
        });

        // Access stays revoked and the row survives for an authorized retry;
        // the Account is never reactivated to make cleanup possible.
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } }))
            .toEqual({ status: "disabled" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: ownerId },
            select: { seq: true },
        })).resolves.toEqual({ seq: ownerSeqBefore + 1 });
        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: ownerId,
                    kind: "account",
                    entityId: "home-governance",
                },
            },
            select: { cursor: true },
        })).resolves.toEqual({ cursor: ownerSeqBefore + 1 });
    });

    it("retains private pet locators after object-store failure and retries them idempotently", async () => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole: "member" });
        const { assetId, objectKey } = await createPrivatePetAsset(accountId);
        const privateFiles = createLocalPrivateFilesBackend({ rootDir: resolveLocalPrivateFilesDir() });
        failPrivateBlobDeletion = true;

        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({
            status: "failed",
            code: "account_erasure_blob_delete_failed",
        });
        expect(privateBlobCalls).toEqual([objectKey]);
        await expect(privateFiles.readPrivateFile(objectKey)).resolves.toEqual(new Uint8Array([1]));
        await expect(db.accountPetAsset.findUnique({ where: { id: assetId } }))
            .resolves.not.toBeNull();

        failPrivateBlobDeletion = false;
        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({ status: "deleted" });
        expect(privateBlobCalls).toEqual([objectKey, objectKey]);
        await expect(privateFiles.readPrivateFile(objectKey)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses final deletion when a retained locator row is replaced at the same storage coordinate", async () => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "member" });
        duringBlobDeletion = async () => {
            duringBlobDeletion = null;
            await db.uploadedFile.deleteMany({ where: { accountId, path } });
            await db.uploadedFile.create({ data: { accountId, path } });
        };

        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({
            status: "failed",
            code: "account_erasure_locator_mismatch",
        });
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } }))
            .toEqual({ status: "disabled" });
    });

    it("refuses an administrative actor who does not hold eraseAccounts authority", async () => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId: adminId } = await createAccountWithBlob({ homeRole: "admin" });
        const { accountId } = await createAccountWithBlob({ homeRole: "member" });

        // Administering Accounts is not authority to destroy one. The refusal
        // must land before any irreversible work and leave the target intact.
        await expect(deleteAccountForErasure({
            accountId,
            actor: { kind: "home_administration", actorAccountId: adminId },
        })).resolves.toEqual({ status: "failed", code: "home_governance_forbidden" });

        expect(blobCalls).toEqual([]);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } }))
            .toEqual({ status: "active" });
    });

    it.each(["member", "admin"] as const)("refuses a %s erasing their own Account through administrative admission", async (homeRole) => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole });

        await expect(deleteAccountForErasure({
            accountId,
            actor: { kind: "home_administration", actorAccountId: accountId },
        })).resolves.toEqual({ status: "failed", code: "home_governance_forbidden" });

        expect(blobCalls).toEqual([]);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } }))
            .toEqual({ status: "active" });
        expect(await db.uploadedFile.count({ where: { accountId } })).toBe(1);
    });

    it("does not reveal an absent Account to an administrative actor without eraseAccounts authority", async () => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId: adminId } = await createAccountWithBlob({ homeRole: "admin" });
        const absentAccountId = "absent-erasure-target";

        await expect(deleteAccountForErasure({
            accountId: absentAccountId,
            actor: { kind: "home_administration", actorAccountId: adminId },
        })).resolves.toEqual({ status: "failed", code: "home_governance_forbidden" });

        await expect(deleteAccountForErasure({
            accountId: absentAccountId,
            actor: { kind: "home_administration", actorAccountId: ownerId },
        })).resolves.toEqual({ status: "already-deleted" });
        await expect(deleteAccountForErasure({ accountId: absentAccountId }))
            .resolves.toEqual({ status: "already-deleted" });
        expect(blobCalls).toEqual([]);
    });

    it("erases another Account for an authorized Home owner", async () => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "member" });
        const ownerSeqBefore = (await db.account.findUniqueOrThrow({
            where: { id: ownerId },
            select: { seq: true },
        })).seq;

        await expect(deleteAccountForErasure({
            accountId,
            actor: { kind: "home_administration", actorAccountId: ownerId },
        })).resolves.toEqual({ status: "deleted" });

        expect(blobCalls).toEqual([{ path, accountStatusAtCall: "disabled" }]);
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
        await expect(db.account.findUniqueOrThrow({
            where: { id: ownerId },
            select: { seq: true },
        })).resolves.toEqual({ seq: ownerSeqBefore + 2 });
    });

    it("completes a Home owner's erasure of their own People row after Phase A revokes them", async () => {
        const { accountId: survivingOwnerId } = await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "owner" });

        // Home People always names the verified actor, including when that
        // actor is the target. Phase A retires and revokes the target on
        // purpose, so rechecking the actor's Home authority in Phase C would
        // refuse the self-erasure it already admitted — after the blobs are
        // irreversibly gone.
        await expect(deleteAccountForErasure({
            accountId,
            actor: { kind: "home_administration", actorAccountId: accountId },
        })).resolves.toEqual({ status: "deleted" });

        expect(blobCalls).toEqual([{ path, accountStatusAtCall: "disabled" }]);
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
        await expect(db.account.findUniqueOrThrow({ where: { id: survivingOwnerId }, select: { status: true } }))
            .resolves.toEqual({ status: "active" });
    });

    it("finishes an admitted administrative erasure after its actor is demoted mid-flight", async () => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId, path } = await createAccountWithBlob({ homeRole: "member" });

        // Authority is decided once, at admission. A demotion that lands while
        // the admitted erasure runs takes effect at the actor's next request;
        // it must not strand the already-retired target half erased.
        duringBlobDeletion = async () => {
            await db.account.update({ where: { id: ownerId }, data: { homeRole: "member" } });
        };

        await expect(deleteAccountForErasure({
            accountId,
            actor: { kind: "home_administration", actorAccountId: ownerId },
        })).resolves.toEqual({ status: "deleted" });

        expect(blobCalls).toEqual([{ path, accountStatusAtCall: "disabled" }]);
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
        // The next request from the demoted actor is refused at its admission.
        const { accountId: nextTargetId } = await createAccountWithBlob({ homeRole: "member" });
        await expect(deleteAccountForErasure({
            accountId: nextTargetId,
            actor: { kind: "home_administration", actorAccountId: ownerId },
        })).resolves.toEqual({ status: "failed", code: "home_governance_forbidden" });
        expect(await db.account.findUniqueOrThrow({ where: { id: nextTargetId }, select: { status: true } }))
            .toEqual({ status: "active" });
    });

    it("settles an admitted administrative erasure as already deleted when a concurrent erasure finished first", async () => {
        const { accountId: ownerId } = await createAccountWithBlob({ homeRole: "owner" });
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole: "member" });
        duringBlobDeletion = async () => {
            duringBlobDeletion = null;
            await db.account.update({ where: { id: ownerId }, data: { homeRole: "admin" } });
            await expect(deleteAccountForErasure({ accountId }))
                .resolves.toEqual({ status: "deleted" });
        };

        await expect(deleteAccountForErasure({
            accountId,
            actor: { kind: "home_administration", actorAccountId: ownerId },
        })).resolves.toEqual({ status: "already-deleted" });
    });

    it("completes an admitted self-erasure through its own credential revocation", async () => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole: "member" });
        const pat = await auth.createApiToken({ accountId, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(accountId, "Self erasure") });

        // Phase A intentionally revokes this Account's own credentials. That
        // must not make the invocation it already admitted impossible to finish.
        await expect(deleteAccountForErasure({ accountId, actor: { kind: "self" } }))
            .resolves.toEqual({ status: "deleted" });
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
        await expect(auth.verifyPat(pat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });
    });

    it("refuses to finish an erasure whose Account was reactivated while objects were deleted", async () => {
        await createAccountWithBlob({ homeRole: "owner" });
        const { accountId } = await createAccountWithBlob({ homeRole: "owner" });

        // Something reactivated the Account in the window Phase A cannot hold
        // a transaction across. Finishing the deletion would silently complete
        // an intent that is no longer current.
        duringBlobDeletion = async () => {
            await db.account.update({ where: { id: accountId }, data: { status: "active" } });
        };

        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({
            status: "failed",
            code: "account_erasure_not_retired",
        });
        expect(await db.account.findUnique({ where: { id: accountId } })).not.toBeNull();
    });
});
