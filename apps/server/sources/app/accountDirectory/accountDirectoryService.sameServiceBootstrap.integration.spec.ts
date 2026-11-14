import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { encodeBase64 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { plainPrivateLabel, prepareE2eePrivateLabelForAccount } from "@/testkit/privateLabelFixture";
import {
    getOrCreateServerIdentityId,
    initializeServerIdentityCache,
} from "@/app/serverIdentity/serverIdentity";
import { createHomeConnectionDescriptorContinuityStoreForServer } from "@/app/features/homeConnectionDescriptorContinuity";
import {
    readHomeConnectionDescriptor,
    resetHomeConnectionDescriptorRevisionOwnerForTests,
} from "@/app/features/homeConnectionDescriptorPublication";

import { AccountDirectoryError } from "./accountDirectoryErrors";
import {
    accountDirectorySigningKeyMetadata,
    resolveAccountDirectorySigningKeyPair,
    verifyHomeLoginAssertionSignature,
} from "./accountDirectorySigner";
import {
    type HomeConnectionDescriptorResolver,
    ensureSameServiceHomeEntryInTx,
    prepareSameServiceHomeEntry,
    listAccountHomeDirectory,
    mintAccountHomeLoginAssertion,
    upsertAccountHomeDirectoryEntry,
} from "./accountDirectoryService";

/**
 * The env of an explicitly dual-role server: one Account-Service-capable
 * instance that also publishes an authoritative Home descriptor (HTTPS ingress
 * composed from the public URL by the canonical descriptor-publication owner).
 */
const DUAL_ROLE_ENV = {
    HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: "self",
    HAPPIER_CANONICAL_SERVER_URL: "https://cloud.example.test",
    HAPPIER_PUBLIC_SERVER_URL: "https://cloud.example.test",
};

async function ensureSameServiceHomeEntry(params: {
    accountId: string;
    env?: NodeJS.ProcessEnv;
    resolveHomeConnectionDescriptor?: HomeConnectionDescriptorResolver;
}) {
    const preparation = await prepareSameServiceHomeEntry(params);
    return inTx((tx) => ensureSameServiceHomeEntryInTx(tx, {
        accountId: params.accountId,
        preparation,
        env: params.env,
    }));
}

async function readCurrentHomeDescriptor() {
    const continuityStore = createHomeConnectionDescriptorContinuityStoreForServer(process.env);
    if (!continuityStore) return undefined;
    return await readHomeConnectionDescriptor({
        env: process.env,
        continuityStore,
        visibility: "authenticated",
    });
}

describe("Account Directory same-service Home bootstrap (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-directory-same-service-bootstrap-",
            initAuth: true,
            env: DUAL_ROLE_ENV,
        });
        await initializeServerIdentityCache(process.env);
    }, 120_000);

    afterEach(async () => {
        await db.accountDirectoryLink.deleteMany();
        await db.accountHomeDirectoryEntry.deleteMany();
        await db.account.deleteMany();
        await db.homeGovernancePolicy.deleteMany();
        harness.resetEnv(DUAL_ROLE_ENV);
        resetHomeConnectionDescriptorRevisionOwnerForTests();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("ensures the self entry, the pinned same-account link, and first-Home preferred transactionally", async () => {
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const signing = accountDirectorySigningKeyMetadata(process.env);
        const account = await db.account.create({
            // A new E2EE Account has no client content key yet. Bootstrap must
            // remain keyless and leave the user-owned label absent.
            data: { publicKey: "same-service-bootstrap-fresh-account", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const outcome = await ensureSameServiceHomeEntry({ accountId: account.id });

        expect(outcome).toEqual({
            status: "ensured",
            homeServerIdentityId: serverIdentityId,
            preferred: true,
        });

        const entries = await db.accountHomeDirectoryEntry.findMany({ where: { accountId: account.id } });
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.homeServerIdentityId).toBe(serverIdentityId);
        expect(entry.canonicalServerUrl).toBe("https://cloud.example.test");
        expect(entry.label).toBe("");
        await expect(listAccountHomeDirectory(account.id)).resolves.toMatchObject({
            homes: [expect.objectContaining({ homeServerIdentityId: serverIdentityId, label: null })],
        });
        const currentDescriptor = await readCurrentHomeDescriptor();
        expect(currentDescriptor).toBeDefined();
        expect(entry.connectionDescriptor).toEqual(currentDescriptor);

        const links = await db.accountDirectoryLink.findMany({ where: { accountId: account.id } });
        expect(links).toHaveLength(1);
        const link = links[0]!;
        expect(link.issuerServerIdentityId).toBe(serverIdentityId);
        expect(link.issuerSubjectId).toBe(account.id);
        expect(link.issuerSigningKeyId).toBe(signing.keyId);
        expect(Buffer.from(link.issuerSigningPublicKey)).toEqual(
            Buffer.from(resolveAccountDirectorySigningKeyPair(process.env).publicKey),
        );

        // The unchanged assertion corridor is immediately usable: the existing
        // mint owner accepts the bootstrapped entry and signs with the pinned key.
        const clientBox = tweetnacl.box.keyPair();
        const assertion = await mintAccountHomeLoginAssertion({
            accountId: account.id,
            homeServerIdentityId: serverIdentityId,
            clientBoxPublicKeyBase64: encodeBase64(new Uint8Array(clientBox.publicKey), "base64"),
        });
        expect(verifyHomeLoginAssertionSignature(assertion, new Uint8Array(link.issuerSigningPublicKey))).toBe("ok");
    });

    it.each([undefined, "disabled", "external"])("does not infer self policy from signing capability when mode is %s", async (mode) => {
        const account = await db.account.create({
            data: { publicKey: `same-service-policy-${mode ?? "absent"}` },
            select: { id: true },
        });
        await ensureSameServiceHomeEntry({
            accountId: account.id,
            env: {
                ...process.env,
                HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: mode,
                HAPPIER_AUTH_SIGN_IN_SERVICE_URL: mode === "external" ? "https://another-service.example.test" : undefined,
            },
        });
        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("preserves an explicit self-Home label across repeated ensure and a newer descriptor", async () => {
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-repeat-account", encryptionMode: "plain" },
            select: { id: true },
        });
        await upsertAccountHomeDirectoryEntry({
            accountId: account.id,
            homeServerIdentityId: "srv_other_home_account",
            label: plainPrivateLabel("Other Home"),
            connectionDescriptor: {
                v: 1,
                homeServerIdentityId: "srv_other_home_account",
                canonicalServerUrl: "https://other.example.test",
                revision: 1,
                endpoints: [{ kind: "https", url: "https://other.example.test" }],
            },
        });

        const first = await ensureSameServiceHomeEntry({ accountId: account.id });
        const afterFirstEnsure = await listAccountHomeDirectory(account.id);
        const selfHome = afterFirstEnsure.homes.find((home) =>
            home.homeServerIdentityId === serverIdentityId);
        expect(selfHome).toBeDefined();
        const renamedLabel = "My renamed Cloud Home";
        await upsertAccountHomeDirectoryEntry({
            accountId: account.id,
            homeServerIdentityId: serverIdentityId,
            label: plainPrivateLabel(renamedLabel),
            connectionDescriptor: selfHome!.connectionDescriptor,
        });

        const second = await ensureSameServiceHomeEntry({ accountId: account.id });
        const higherRevision = selfHome!.connectionDescriptor.revision + 1;
        const third = await ensureSameServiceHomeEntry({
            accountId: account.id,
            resolveHomeConnectionDescriptor: async () => ({
                ...selfHome!.connectionDescriptor,
                revision: higherRevision,
            }),
        });

        expect(first).toEqual({ status: "ensured", homeServerIdentityId: serverIdentityId, preferred: false });
        expect(second).toEqual(first);
        expect(third).toEqual(first);

        const directory = await listAccountHomeDirectory(account.id);
        expect(directory.preferredHomeServerIdentityId).toBe("srv_other_home_account");
        expect(directory.homes).toHaveLength(2);
        expect(directory.homes.find((home) => home.homeServerIdentityId === serverIdentityId))
            .toMatchObject({
                label: { content: { t: "plain", v: renamedLabel }, recipientEnvelope: null },
                connectionDescriptor: { revision: higherRevision },
            });
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("stores structurally valid plain Home labels without reading their client-owned text", async () => {
        const account = await db.account.create({
            data: { publicKey: "same-service-home-opaque-plain-label", encryptionMode: "plain" },
            select: { id: true },
        });
        const homeServerIdentityId = "srv_opaque_plain_label";
        // The UI validates a person's label before sealing it. The server only
        // owns the stored-envelope, persisted-mode, and recipient checks.
        const label = plainPrivateLabel("   ");
        await upsertAccountHomeDirectoryEntry({
            accountId: account.id,
            homeServerIdentityId,
            label,
            connectionDescriptor: {
                v: 1,
                homeServerIdentityId,
                canonicalServerUrl: "https://opaque-plain.example.test",
                revision: 1,
                endpoints: [{ kind: "https", url: "https://opaque-plain.example.test" }],
            },
        });

        await expect(db.accountHomeDirectoryEntry.findUniqueOrThrow({
            where: { accountId_homeServerIdentityId: { accountId: account.id, homeServerIdentityId } },
            select: { label: true },
        })).resolves.toEqual({ label: JSON.stringify(label) });
        await expect(listAccountHomeDirectory(account.id)).resolves.toMatchObject({
            homes: [expect.objectContaining({
                homeServerIdentityId,
                label: { content: label.content, recipientEnvelope: null },
            })],
        });
    });

    it("stores an intentional E2EE Home label opaque and returns only this Account's envelope", async () => {
        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
            select: { id: true },
        });
        const homeServerIdentityId = "srv_e2ee_labeled_home";
        const label = await prepareE2eePrivateLabelForAccount(account.id, {
            entity: "account_directory_home",
            field: "label",
            id: homeServerIdentityId,
        }, "Private Home");
        await upsertAccountHomeDirectoryEntry({
            accountId: account.id,
            homeServerIdentityId,
            label,
            connectionDescriptor: {
                v: 1,
                homeServerIdentityId,
                canonicalServerUrl: "https://private.example.test",
                revision: 1,
                endpoints: [{ kind: "https", url: "https://private.example.test" }],
            },
        });

        const stored = await db.accountHomeDirectoryEntry.findUniqueOrThrow({
            where: { accountId_homeServerIdentityId: { accountId: account.id, homeServerIdentityId } },
            select: { label: true },
        });
        expect(stored.label).not.toContain("Private Home");
        const home = (await listAccountHomeDirectory(account.id)).homes.find((entry) =>
            entry.homeServerIdentityId === homeServerIdentityId);
        expect(home?.label).toMatchObject({ content: { t: "encrypted" }, recipientEnvelope: expect.any(Object) });
        expect(home?.label).not.toHaveProperty("recipients");
    });

    it("creates no trust rows when the server publishes no Home descriptor (Account-Service-only runtime)", async () => {
        harness.resetEnv({
            HAPPIER_CANONICAL_SERVER_URL: undefined,
            HAPPIER_PUBLIC_SERVER_URL: undefined,
        });
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-service-only-account" },
            select: { id: true },
        });

        const outcome = await ensureSameServiceHomeEntry({ accountId: account.id });

        expect(outcome).toEqual({ status: "not_dual_role", reason: "home_descriptor_unavailable" });
        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("keeps a transient descriptor-resolution failure retryable instead of classifying the server as service-only", async () => {
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-transient-descriptor-failure" },
            select: { id: true },
        });

        await expect(ensureSameServiceHomeEntry({
            accountId: account.id,
            resolveHomeConnectionDescriptor: async () => {
                throw new Error("temporary descriptor read failure");
            },
        })).rejects.toThrow("temporary descriptor read failure");

        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("revalidates self policy before writing the prepared Home link", async () => {
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-write-boundary" },
            select: { id: true },
        });
        const preparation = await prepareSameServiceHomeEntry({});
        expect(preparation.status).toBe("ready");
        harness.resetEnv({ HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: "disabled" });
        const outcome = await inTx((tx) => ensureSameServiceHomeEntryInTx(tx, {
            accountId: account.id,
            preparation,
        }));
        expect(outcome).toEqual({ status: "not_dual_role", reason: "sign_in_service_not_self" });
        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("honours a Home governance narrowing that disables the sign-in service on a dual-role deployment", async () => {
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                authenticationPolicy: { v: 1, signInService: { mode: "disabled" } },
            },
        });
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-governance-narrowed" },
            select: { id: true },
        });

        // The preflight sees only the deployment, which is still `self`; the
        // narrowing is applied where the write is authorized.
        const preparation = await prepareSameServiceHomeEntry({});
        expect(preparation.status).toBe("ready");

        const outcome = await ensureSameServiceHomeEntry({ accountId: account.id });

        expect(outcome).toEqual({ status: "not_dual_role", reason: "sign_in_service_not_self" });
        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("creates no trust rows when the Account Service signing metadata is unavailable", async () => {
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-no-signing-account" },
            select: { id: true },
        });

        const outcome = await ensureSameServiceHomeEntry({
            accountId: account.id,
            env: { HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: "self" },
        });

        expect(outcome).toEqual({
            status: "not_dual_role",
            reason: "account_service_signing_metadata_unavailable",
        });
        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("fails closed when the resolved descriptor names a different server identity", async () => {
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-wrong-identity-account" },
            select: { id: true },
        });

        const outcome = await ensureSameServiceHomeEntry({
            accountId: account.id,
            resolveHomeConnectionDescriptor: async () => ({
                v: 1,
                homeServerIdentityId: "srv_some_other_instance",
                canonicalServerUrl: "https://cloud.example.test",
                revision: 1,
                endpoints: [{ kind: "https", url: "https://cloud.example.test" }],
            }),
        });

        expect(outcome).toEqual({ status: "not_dual_role", reason: "server_identity_mismatch" });
        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.accountDirectoryLink.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("fails closed on an existing different link instead of silently relinking", async () => {
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const signing = accountDirectorySigningKeyMetadata(process.env);
        const account = await db.account.create({
            data: { publicKey: "same-service-bootstrap-link-conflict-account" },
            select: { id: true },
        });
        await db.accountDirectoryLink.create({
            data: {
                accountId: account.id,
                issuerServerIdentityId: serverIdentityId,
                issuerSubjectId: "a-different-subject",
                issuerSigningKeyId: signing.keyId,
                issuerSigningPublicKey: Buffer.from(resolveAccountDirectorySigningKeyPair(process.env).publicKey),
            },
        });

        await expect(ensureSameServiceHomeEntry({ accountId: account.id }))
            .rejects.toMatchObject({ name: "AccountDirectoryError", code: "directory_link_conflict" } satisfies Partial<AccountDirectoryError>);

        expect(await db.accountHomeDirectoryEntry.count({ where: { accountId: account.id } })).toBe(0);
        const links = await db.accountDirectoryLink.findMany({ where: { accountId: account.id } });
        expect(links).toHaveLength(1);
        expect(links[0]!.issuerSubjectId).toBe("a-different-subject");
    });
});
