import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
    formatSharedSavedSecretRefV1,
    promotePersonalSavedSecretReference,
    sealEncryptedDataKeyEnvelopeV1,
    sealSavedSecretResourceStoredContentV1,
    signAccountContentKeyBindingV1,
    verifyAccountContentKeyBindingV1,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { openPlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";

import {
    SavedSecretResourceTransactionAbort,
    createSavedSecretResourceInTx,
    deleteSavedSecretResourceInTx,
    listSavedSecretResourceMaterialsForAccountInTx,
    listSavedSecretResourcesForAccountInTx,
    promoteSavedSecretResourceInTx,
    repairSavedSecretResourceKeyEnvelopesInTx,
    setSavedSecretResourceGrantsInTx,
    updateSavedSecretResourceInTx,
} from "./savedSecretResourceService";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { buildProfilePhysicalKey, PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } from '@/app/kv/accountScopedKv';
import { resolveEffectiveProfileSecretBindingsV1, sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import * as resourceService from './savedSecretResourceService';
import { createArtifactTx, updateArtifactTx } from '@/app/artifacts/artifactWriteService';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { mutateProfileTransferInTx, readProfileTransferControlInTx } from '@/app/account/profiles/profileTransferRows';
import { mutateProfileRowsInTx } from '@/app/account/profiles/profileRows';
import { prepareAcpCatalogTransferV2 } from '@happier-dev/protocol/acp/catalog/transferAcpCatalogV2';
import { KIRO_ACP_STDERR_RULES } from '@happier-dev/plugins-kiro/agent/acp/transport';
import { mutateRemoteHostCatalogRowInTx } from '@/app/account/remoteHosts/remoteHostRows';

const ACCEPTED_EMAIL_PASSWORD = { kind: "home_method" as const, methodId: "email_password" };
const EMAIL_PASSWORD_EVIDENCE = [ACCEPTED_EMAIL_PASSWORD];
const HOME_OFFERS_EMAIL_PASSWORD = {
    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
};

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

function sealTestResource(resourceId: string, name = "Shared token") {
    return sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: "e2ee",
        resourceDataKey: new Uint8Array(32).fill(7),
        content: { v: 1, name, kind: "token", value: "secret-value" },
        randomBytes: (length) => new Uint8Array(length).fill(8),
    });
}

describe("Saved Secret resource service (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-saved-secret-resource-",
            initAuth: false,
            initEncrypt: true,
        });
    }, 300_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.savedSecretResourceKeyEnvelope.deleteMany(),
            () => db.savedSecretGroupGrant.deleteMany(),
            () => db.savedSecretTeamGrant.deleteMany(),
            () => db.savedSecretAccountGrant.deleteMany(),
            () => db.savedSecretResource.deleteMany(),
            () => db.managedMachine.deleteMany(),
            () => db.managedMachinePreset.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.accountSettingsSnapshot.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.artifactAccountGrant.deleteMany(),
            () => db.artifactRevision.deleteMany(),
            () => db.artifact.deleteMany(),
            () => db.teamGroupMembership.deleteMany(),
            () => db.teamGroup.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.accountPasswordCredential.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.userRelationship.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('commits two new credentials and their connected catalog despite unrelated Settings drift and refuses a stale catalog', async () => {
        const key = '@happier/account/connected-configurations/v1/catalog';
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: { preferredLanguage: 'de' } }) }, select: { id: true } });
        await db.userKVStore.create({ data: { accountId: owner.id, key, version: 0,
            value: Buffer.from(JSON.stringify({ t: 'plain', v: { key: 'configurations', value: { v: 1, entries: [] } } })) } });
        const create = (resourceId: string) => ({ resourceId, displayName: 'Credential', kind: 'token' as const,
            encryptionMode: 'plain' as const,
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Credential', kind: 'token' as const, value: 'private' } } });
        const first = create('connected-atomic-first');
        const second = create('connected-atomic-second');
        const catalog = { v: 1 as const, entries: [{ service: { pluginId: 'happier.fixture', localId: 'service' },
            modeId: 'api', revision: 'v1', values: { unchanged: 'config' }, secretRefs: {
                first: formatSharedSavedSecretRefV1(first.resourceId), second: formatSharedSavedSecretRefV1(second.resourceId),
            } }] };
        const input = { ...first, accountId: owner.id, nextSettings: null, profileMutations: [],
            additionalSavedSecretResources: [second],
            referenceCensus: { scope: 'catalogs' as const, accountMode: 'plain' as const,
                catalogs: { connectedConfigurations: 0 } },
            catalogMutations: { connectedConfigurations: { expectedRevision: 0,
                content: { t: 'plain' as const, v: { key: 'configurations' as const, value: catalog } },
                referencedSavedSecretIds: [formatSharedSavedSecretRefV1(first.resourceId), formatSharedSavedSecretRefV1(second.resourceId)],
                savedSecretRevisions: [{ resourceId: first.resourceId, expectedRevision: 1 }, { resourceId: second.resourceId, expectedRevision: 1 }] } } };
        await db.account.update({ where: { id: owner.id }, data: { settingsVersion: 5,
            settings: JSON.stringify({ t: 'plain', v: { preferredLanguage: 'fr' } }) } });
        await db.userKVStore.createMany({ data: [
            { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 7, value: null },
            { accountId: owner.id, key: '@happier/account/mcp/v1/catalog', version: 3,
                value: Buffer.from(JSON.stringify({ t: 'plain', v: { v: 1, servers: [], bindings: [] } })) },
        ] });
        const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, input));
        expect(result).toMatchObject({ ok: true, value: { resourceId: first.resourceId, settingsVersion: 5 } });
        expect(await db.savedSecretResource.count()).toBe(2);
        const row = await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key } } });
        expect(row?.version).toBe(1);
        expect(row?.value && JSON.parse(Buffer.from(row.value).toString('utf8'))).toEqual({ t: 'plain', v: { key: 'configurations', value: catalog } });
        const account = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { settingsVersion: true, settings: true } });
        expect(account.settingsVersion).toBe(5);
        expect(openPlainAccountSettingsDbValue({ accountId: owner.id, dbValue: account.settings })).toEqual({ t: 'plain', v: { preferredLanguage: 'fr' } });
        expect(await db.accountSettingsSnapshot.count()).toBe(0);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id,
            key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } }, select: { version: true } })).toEqual({ version: 7 });
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, input))).toEqual(result);
        const stale = { ...input, ...create('connected-stale-resource'), additionalSavedSecretResources: [],
            catalogMutations: { connectedConfigurations: { ...input.catalogMutations.connectedConfigurations,
                content: { t: 'plain' as const, v: { key: 'configurations' as const, value: { v: 1 as const, entries: [] } } },
                referencedSavedSecretIds: [], savedSecretRevisions: [] } } };
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, stale))).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.count()).toBe(2);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key } }, select: { version: true } })).toEqual({ version: 1 });
        const unbound = { ...stale, ...create('connected-unbound-resource'),
            referenceCensus: { ...input.referenceCensus, catalogs: { connectedConfigurations: 1 } },
            catalogMutations: { connectedConfigurations: { ...stale.catalogMutations.connectedConfigurations, expectedRevision: 1 } } };
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, unbound))).toEqual({ ok: false, error: 'references_invalid' });
        expect(await db.savedSecretResource.count()).toBe(2);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key } }, select: { version: true } })).toEqual({ version: 1 });
    });

    it('promotes a genuine ACP source credential, activates its original catalog and cleans Settings in one transaction', async () => {
        // Observed predecessor 37a6541578749067b49d4579be8c752c9591b8c8;
        // transferAcpCatalogV2.test.ts pins the complete predecessor producer vector.
        const raw = { preferredLanguage: 'de', secrets: [{ id: 'old-token', name: 'Token', kind: 'token',
            encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'retained-source-ciphertext' } },
            createdAt: 1, updatedAt: 2 }], acpCatalogSettingsV1: { v: 2, backends: [{
            id: 'configured-kiro', name: 'configured-kiro', title: 'Configured Kiro', description: 'Custom launch',
            command: 'custom-kiro-cli', args: ['acp'],
            env: { REGION: { t: 'literal', v: 'eu' }, TOKEN: { t: 'savedSecret', secretId: 'old-token' } },
            auth: { support: 'login_terminal', machineLoginKey: 'my-login', docsUrl: 'https://example.test/auth',
                loginCommand: { command: 'custom-kiro-cli', args: ['login'] }, envVars: ['TOKEN'],
                statusCommand: ['whoami', '--format', 'json'], parser: 'kiroWhoamiJson' },
            transportProfile: 'kiro', defaultMode: 'default', defaultModel: 'model-pro',
            capabilities: { supportsLoadSession: true, supportsModes: 'yes', supportsModels: 'yes', supportsConfigOptions: 'no', promptImageSupport: 'yes' },
            createdAt: 1, updatedAt: 2,
        }, { id: 'generic', name: 'generic', title: 'Generic', command: 'generic-cli', transportProfile: 'generic', createdAt: 3, updatedAt: 4 }] } };
        const intermediate = { preferredLanguage: raw.preferredLanguage, secrets: raw.secrets };
        const key = '@happier/account/acp/v1/catalog';
        const prepare = async () => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7,
                settings: JSON.stringify({ t: 'plain', v: raw }) }, select: { id: true } });
            const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id,
                source: { kind: 'personal-saved-secret', secretId: 'old-token' } });
            const ref = formatSharedSavedSecretRefV1(resourceId);
            const prepared = prepareAcpCatalogTransferV2({ rawSettings: raw, sourceSettingsVersion: 7,
                savedSecretRefs: new Map([['old-token', ref]]), kiroStderrRules: KIRO_ACP_STDERR_RULES });
            expect(prepared.status).toBe('ready');
            if (prepared.status !== 'ready') throw new Error('The pinned predecessor source must prepare completely');
            const input = { accountId: owner.id, resourceId, displayName: 'Token', kind: 'token' as const,
                encryptionMode: 'plain' as const, storedContent: { t: 'plain' as const,
                    v: { v: 1 as const, name: 'Token', kind: 'token' as const, value: 'source-private' } },
                expectedSettingsVersion: 7, nextSettings: { t: 'plain' as const, v: { preferredLanguage: 'de', secrets: [] } },
                profileMutations: [], referenceCensus: { accountMode: 'plain' as const,
                    profileTransferRevision: 'absent' as const, profiles: { referenceGuardRevision: 'absent' as const, rows: [] }, artifacts: [],
                    catalogs: { mcp: 'absent' as const, acp: 'absent' as const, providerConnections: 'absent' as const,
                        connectedConfigurations: 'absent' as const, connectedPurposes: 'absent' as const } },
                catalogMutations: { acp: { expectedRevision: 'absent' as const, source: 'predecessor' as const,
                    sourceSettingsVersion: 7, content: { t: 'plain' as const, v: prepared.record },
                    settingsCleanup: { expectedSettingsVersion: 7, nextSettings: { t: 'plain' as const, v: intermediate } },
                    referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] } } };
            return { owner, input, record: prepared.record };
        };
        const first = await prepare();
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, first.input)))
            .toEqual({ ok: true, value: { resourceId: first.input.resourceId, settingsVersion: 8 } });
        const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: first.owner.id, key } } });
        expect(row.version).toBe(0);
        expect(row.value && JSON.parse(Buffer.from(row.value).toString('utf8'))).toEqual({ t: 'plain', v: first.record });
        const account = await db.account.findUniqueOrThrow({ where: { id: first.owner.id }, select: { settingsVersion: true, settings: true } });
        expect(account.settingsVersion).toBe(8);
        expect(openPlainAccountSettingsDbValue({ accountId: first.owner.id, dbValue: account.settings })).toEqual(first.input.nextSettings);
        expect(await db.savedSecretResource.count()).toBe(1);
        expect(await db.accountSettingsSnapshot.findMany({ select: { version: true }, orderBy: { version: 'asc' } })).toEqual([{ version: 7 }, { version: 8 }]);

        const retainedSource = await prepare();
        const invalidCleanup = { ...retainedSource.input, nextSettings: { t: 'plain' as const,
            v: { ...raw, secrets: [] } } };
        const cleanupRefusal = await inTx(tx => promoteSavedSecretResourceInTx(tx, invalidCleanup)).catch(error => {
            if (error instanceof SavedSecretResourceTransactionAbort) return { ok: false, error: error.error };
            throw error;
        });
        expect(cleanupRefusal).toEqual({ ok: false, error: 'references_invalid' });
        expect(await db.savedSecretResource.count()).toBe(1);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: retainedSource.owner.id, key } } })).toBeNull();
        const retainedAccount = await db.account.findUniqueOrThrow({ where: { id: retainedSource.owner.id }, select: { settingsVersion: true, settings: true } });
        expect(retainedAccount.settingsVersion).toBe(7);
        expect(openPlainAccountSettingsDbValue({ accountId: retainedSource.owner.id, dbValue: retainedAccount.settings })).toEqual({ t: 'plain', v: raw });
        expect(await db.accountSettingsSnapshot.count()).toBe(2);

        const disagreement = await prepare();
        const modified = { ...disagreement.input, catalogMutations: { acp: { ...disagreement.input.catalogMutations.acp,
            content: { t: 'plain' as const, v: { ...disagreement.record, definitions: disagreement.record.definitions.map((definition, index) =>
                index === 0 ? { ...definition, command: 'user-edited-before-source-activation' } : definition) } } } } };
        const rejected = await inTx(tx => promoteSavedSecretResourceInTx(tx, modified)).catch(error => {
            if (error instanceof SavedSecretResourceTransactionAbort) return { ok: false, error: error.error };
            throw error;
        });
        expect(rejected).toEqual({ ok: false, error: 'references_invalid' });
        expect(await db.savedSecretResource.count()).toBe(1);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: disagreement.owner.id, key } } })).toBeNull();
        const unchanged = await db.account.findUniqueOrThrow({ where: { id: disagreement.owner.id }, select: { settingsVersion: true, settings: true } });
        expect(unchanged.settingsVersion).toBe(7);
        expect(openPlainAccountSettingsDbValue({ accountId: disagreement.owner.id, dbValue: unchanged.settings })).toEqual({ t: 'plain', v: raw });
        expect(await db.accountSettingsSnapshot.count()).toBe(2);
        const stale = await prepare();
        await db.account.update({ where: { id: stale.owner.id }, data: { settingsVersion: 8 } });
        const staleResult = await inTx(tx => promoteSavedSecretResourceInTx(tx, stale.input)).catch(error => {
            if (error instanceof SavedSecretResourceTransactionAbort) return { ok: false, error: error.error };
            throw error;
        });
        expect(staleResult).toEqual({ ok: false, error: 'settings_conflict' });
        expect(await db.savedSecretResource.count()).toBe(1);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: stale.owner.id, key } } })).toBeNull();
        const staleAccount = await db.account.findUniqueOrThrow({ where: { id: stale.owner.id }, select: { settingsVersion: true, settings: true } });
        expect(staleAccount.settingsVersion).toBe(8);
        expect(openPlainAccountSettingsDbValue({ accountId: stale.owner.id, dbValue: staleAccount.settings })).toEqual({ t: 'plain', v: raw });
        expect(await db.accountSettingsSnapshot.count()).toBe(2);
    });

    it('commits a new SSH credential and its host catalog without rewriting Settings, and verifies a lost-response retry', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: { themePreference: 'dark' } }) }, select: { id: true } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 7, value: null } });
        const catalog = { v: 1 as const, hosts: [{ id: 'host-atomic', name: 'Build host',
            ssh: { target: 'builder@example.test', authMode: 'password' as const,
                passwordSecretRef: formatSharedSavedSecretRefV1('ssh-atomic-secret') },
            createdAt: 1, updatedAt: 1, lastUsedAt: null }] };
        const input = { accountId: owner.id, resourceId: 'ssh-atomic-secret', displayName: 'SSH password',
            kind: 'password' as const, encryptionMode: 'plain' as const,
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'SSH password', kind: 'password' as const, value: 'private' } },
            nextSettings: null, profileMutations: [],
            referenceCensus: { scope: 'catalogs' as const, accountMode: 'plain' as const, catalogs: {},
                remoteHosts: { revision: 'absent' as const, resourceRefs: [] } },
            remoteHostMutation: { expectedRevision: 'absent' as const, sourceSettingsVersion: 4,
                content: { t: 'plain' as const, v: catalog },
                referencedSavedSecretRevisions: [{ resourceId: 'ssh-atomic-secret', revision: 1 }] } };
        const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, input));
        expect(result).toEqual({ ok: true, value: { resourceId: input.resourceId, settingsVersion: 4, remoteHostRevision: 0 } });
        const row = await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id,
            key: '@happier/account/remote-hosts/v1/catalog' } } });
        expect(row?.version).toBe(0);
        expect(row?.value && JSON.parse(Buffer.from(row.value).toString('utf8'))).toEqual({ t: 'plain', v: catalog });
        expect(await db.account.findUnique({ where: { id: owner.id }, select: { settingsVersion: true } })).toEqual({ settingsVersion: 4 });
        expect(await db.accountSettingsSnapshot.count()).toBe(0);
        await db.account.update({ where: { id: owner.id }, data: { settingsVersion: 5 } });
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, input))).toEqual({ ok: true,
            value: { resourceId: input.resourceId, settingsVersion: 5, remoteHostRevision: 0 } });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id,
            key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } }, select: { version: true } })).toEqual({ version: 7 });
        expect(await db.savedSecretResource.count()).toBe(1);
    });

    it('commits a scoped SSH credential batch without a Settings or Profile census and refuses a stale host catalog', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4 }, select: { id: true } });
        const key = '@happier/account/remote-hosts/v1/catalog';
        expect(await inTx(tx => mutateRemoteHostCatalogRowInTx(tx, { accountId: owner.id,
            expectedRevision: 'absent', sourceSettingsVersion: 4, content: { t: 'plain', v: { v: 1, hosts: [] } },
            referencedSavedSecretRevisions: [] }))).toMatchObject({ status: 'updated', revision: 0 });
        const create = (resourceId: string) => ({ resourceId, displayName: 'SSH credential', kind: 'password' as const,
            encryptionMode: 'plain' as const,
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'SSH credential', kind: 'password' as const, value: 'private' } } });
        const first = create('ssh-scoped-password');
        const second = create('ssh-scoped-key');
        const catalog = { v: 1 as const, hosts: [{ id: 'host-scoped', name: 'Build host',
            ssh: { target: 'builder@example.test', authMode: 'password' as const,
                passwordSecretRef: formatSharedSavedSecretRefV1(first.resourceId),
                identityPrivateKeySecretRef: formatSharedSavedSecretRefV1(second.resourceId) },
            createdAt: 1, updatedAt: 1, lastUsedAt: null }] };
        const input = { ...first, accountId: owner.id, nextSettings: null, profileMutations: [],
            additionalSavedSecretResources: [second],
            referenceCensus: { scope: 'catalogs' as const, accountMode: 'plain' as const, catalogs: {},
                remoteHosts: { revision: 0, resourceRefs: [] } },
            remoteHostMutation: { expectedRevision: 0, content: { t: 'plain' as const, v: catalog },
                referencedSavedSecretRevisions: [{ resourceId: first.resourceId, revision: 1 }, { resourceId: second.resourceId, revision: 1 }] } };
        await db.account.update({ where: { id: owner.id }, data: { settingsVersion: 5 } });
        await db.userKVStore.create({ data: { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 7, value: null } });
        const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, input));
        expect(result).toEqual({ ok: true, value: { resourceId: first.resourceId, settingsVersion: 5, remoteHostRevision: 1 } });
        expect(await db.savedSecretResource.count()).toBe(2);
        expect(await db.accountSettingsSnapshot.count()).toBe(0);
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { settingsVersion: true } })).toEqual({ settingsVersion: 5 });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } }, select: { version: true } })).toEqual({ version: 7 });
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, input))).toEqual(result);
        const stale = { ...input, ...create('ssh-scoped-stale'), additionalSavedSecretResources: [],
            remoteHostMutation: { ...input.remoteHostMutation, content: { t: 'plain' as const, v: { v: 1 as const, hosts: [] } },
                referencedSavedSecretRevisions: [] } };
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, stale))).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.count()).toBe(2);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key } }, select: { version: true } })).toEqual({ version: 1 });
    });

    it('refuses personal source rewrites in a scoped catalog credential batch before any resource or Machine write', async () => {
        const raw = { preferredLanguage: 'de', secrets: [{ id: 'personal-source', name: 'Credential', kind: 'token',
            encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'source-ciphertext' } }, createdAt: 1, updatedAt: 2 }] };
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4,
            settings: JSON.stringify({ t: 'plain', v: raw }) }, select: { id: true } });
        const controller = await db.machine.create({ data: { id: 'scoped-controller', accountId: owner.id, metadata: 'captured-metadata' } });
        const environment = { secretRefs: { v: 1, bindings: { TOKEN: { ref: 'personal-source', revision: 1 } } } };
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const preset = await db.managedMachinePreset.create({ data: { homeId: 'scoped-home', name: 'Scoped preset',
            custodianAccountId: owner.id, controllerMachineId: controller.id, controllerInstallationId: 'scoped-install', launch, environment } });
        const machine = await db.managedMachine.create({ data: { homeId: 'scoped-home', custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: 'scoped-install', admittedActionRequestId: 'scoped-request',
            admittedInput: {}, launch, retention: {}, wakeOnAcceptedMessage: false, environmentSetup: { environment } } });
        const key = '@happier/account/connected-configurations/v1/catalog';
        await db.userKVStore.create({ data: { accountId: owner.id, key, version: 0,
            value: Buffer.from(JSON.stringify({ t: 'plain', v: { key: 'configurations', value: { v: 1, entries: [] } } })) } });
        const resourceId = 'scoped-personal-destination';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const input = { accountId: owner.id, resourceId, displayName: 'Credential', kind: 'token' as const,
            encryptionMode: 'plain' as const, storedContent: { t: 'plain' as const,
                v: { v: 1 as const, name: 'Credential', kind: 'token' as const, value: 'private' } },
            nextSettings: null, profileMutations: [], personalSecretPromotions: [{ personalSecretId: 'personal-source', resourceId }],
            referenceCensus: { scope: 'catalogs' as const, accountMode: 'plain' as const, catalogs: { connectedConfigurations: 0 } },
            catalogMutations: { connectedConfigurations: { expectedRevision: 0,
                content: { t: 'plain' as const, v: { key: 'configurations' as const, value: { v: 1 as const, entries: [{
                    service: { pluginId: 'happier.fixture', localId: 'service' }, modeId: 'api', revision: 'v1', values: {}, secretRefs: { TOKEN: ref },
                }] } } }, referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] } } };
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, input))).toEqual({ ok: false, error: 'references_invalid' });
        expect(await db.savedSecretResource.count()).toBe(0);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key } }, select: { version: true } })).toEqual({ version: 0 });
        const account = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { settingsVersion: true, settings: true } });
        expect(account.settingsVersion).toBe(4);
        expect(openPlainAccountSettingsDbValue({ accountId: owner.id, dbValue: account.settings })).toEqual({ t: 'plain', v: raw });
        expect(await db.machine.findUniqueOrThrow({ where: { id: controller.id } })).toEqual(controller);
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: preset.id } })).toEqual(preset);
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: machine.id } })).toEqual(machine);
        expect(await db.accountSettingsSnapshot.count()).toBe(0);
    });

    it('rolls back every SSH resource when a host catalog conflicts or one referenced resource is invalid', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4 }, select: { id: true } });
        const catalog = { v: 1 as const, hosts: [{ id: 'host-multi', name: 'Build host',
            ssh: { target: 'builder@example.test', authMode: 'password' as const,
                passwordSecretRef: formatSharedSavedSecretRefV1('ssh-multi-password'),
                identityPrivateKeySecretRef: formatSharedSavedSecretRefV1('ssh-multi-key') },
            createdAt: 1, updatedAt: 1, lastUsedAt: null }] };
        const input = { accountId: owner.id, resourceId: 'ssh-multi-password', displayName: 'SSH password',
            kind: 'password' as const, encryptionMode: 'plain' as const,
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'SSH password', kind: 'password' as const, value: 'private-password' } },
            expectedSettingsVersion: 4, nextSettings: null, profileMutations: [],
            referenceCensus: { accountMode: 'plain' as const, profiles: { referenceGuardRevision: 'absent' as const, rows: [] } },
            additionalSavedSecretResources: [{ resourceId: 'ssh-multi-key', displayName: 'SSH private key',
                kind: 'other' as const, encryptionMode: 'plain' as const,
                storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'SSH private key', kind: 'other' as const, value: 'private-key' } } }],
            remoteHostMutation: { expectedRevision: 'absent' as const, sourceSettingsVersion: 4,
                content: { t: 'plain' as const, v: catalog }, referencedSavedSecretRevisions: [
                    { resourceId: 'ssh-multi-password', revision: 1 }, { resourceId: 'ssh-multi-key', revision: 1 }] } };
        const badResource = { ...input, additionalSavedSecretResources: [{ ...input.additionalSavedSecretResources[0],
            storedContent: { ...input.additionalSavedSecretResources[0]!.storedContent,
                v: { ...input.additionalSavedSecretResources[0]!.storedContent.v, name: 'Wrong metadata' } } }] };
        await expect(inTx(tx => promoteSavedSecretResourceInTx(tx, badResource))).rejects.toMatchObject({ error: 'invalid_resource' });
        expect(await db.savedSecretResource.count()).toBe(0);
        expect(await db.userKVStore.count()).toBe(0);
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, input))).toMatchObject({ ok: true, value: { remoteHostRevision: 0 } });
        const staleResourceId = 'ssh-stale-resource';
        const stale = { ...input, resourceId: staleResourceId, remoteHostMutation: {
            ...input.remoteHostMutation, content: { t: 'plain' as const, v: { ...catalog,
                hosts: catalog.hosts.map(host => ({ ...host, ssh: { ...host.ssh,
                    passwordSecretRef: formatSharedSavedSecretRefV1(staleResourceId) } })) } },
            referencedSavedSecretRevisions: [{ resourceId: staleResourceId, revision: 1 },
                { resourceId: 'ssh-multi-key', revision: 1 }] } };
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, stale))).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.count()).toBe(2);
        expect(await db.accountSettingsSnapshot.count()).toBe(0);
    });

    it.each(['plain', 'e2ee'] as const)('retains a shared secret referenced by an archived machine preset for a %s Account', async (accountMode) => {
        const owner = await db.account.create({ data: accountMode === 'e2ee' ? createE2eeAccountMaterial().account : { encryptionMode: accountMode } });
        const resourceId = `preset-setup-${accountMode}`;
        await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Setup token',
            kind: 'token', encryptionMode: 'plain', storedContent: { t: 'plain',
                v: { v: 1, name: 'Setup token', kind: 'token', value: 'private' } } }));
        const preset = await db.managedMachinePreset.create({ data: { homeId: 'preset-home', name: 'Archived preset',
            custodianAccountId: owner.id, controllerMachineId: 'preset-controller', controllerInstallationId: 'preset-install',
            launch: { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            archivedAt: new Date(), environment: { setupScript: 'echo setup', futureField: true,
                secretRefs: { v: 1, bindings: { TOKEN: { ref: formatSharedSavedSecretRefV1(resourceId), revision: 1 } } } } } });
        const input = { accountId: owner.id, resourceId, expectedRevision: 1, expectedSettingsVersion: 0,
            referenceCensus: { accountMode, profiles: { referenceGuardRevision: 'absent' as const, rows: [] } } };
        expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, input))).toEqual({ ok: false, error: 'resource_in_use' });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).not.toBeNull();
        await db.managedMachinePreset.delete({ where: { id: preset.id } });
        expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, input))).toEqual({ ok: true, value: { resourceId } });
    });

    it("refuses deletion when the reference census Settings version is stale", async () => {
        const owner = await db.account.create({
            data: { encryptionMode: "plain", settingsVersion: 4 },
            select: { id: true },
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_stale_census",
            displayName: "Token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Token", kind: "token", value: "private" } },
        }));
        const result = await inTx((tx) => deleteSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_stale_census",
            expectedRevision: 1,
            expectedSettingsVersion: 3,
            referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
        }));
        expect(result).toEqual({ ok: false, error: "settings_conflict" });
        expect(await db.savedSecretResource.findUnique({ where: { id: "resource_stale_census" } })).not.toBeNull();
    });

    it('refuses a Profile-only census once an MCP destination catalog exists', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 4 }, select: { id: true } });
        const resourceId = 'resource_mcp_census';
        await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Token',
            kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } } }));
        const catalog = { v: 1, servers: [{ id: 'server-a', name: 'server-a', transport: 'http',
            remote: { url: 'https://example.test/mcp', headers: {} }, env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1(resourceId) } },
            createdAt: 1, updatedAt: 1 }], bindings: [] };
        await db.userKVStore.create({ data: { accountId: owner.id, key: '@happier/account/mcp/v1/catalog', version: 0,
            value: Buffer.from(JSON.stringify({ t: 'plain', v: catalog })) } });
        const result = await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, expectedRevision: 1,
            expectedSettingsVersion: 4, referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } }));
        expect(result).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.count()).toBe(1);
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: '@happier/account/mcp/v1/catalog' } } }))
            .toMatchObject({ version: 0 });
        expect(await db.userKVStore.count({ where: { key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } })).toBe(0);
    });

    it('proves each historical SavedSecret source identity against its current owned destination revision', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const savedSecretId = 'legacy-secret-for-history';
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id,
            source: { kind: 'personal-saved-secret', secretId: savedSecretId } });
        await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Token',
            kind: 'token', encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } } }));
        const proof = { savedSecretId, resourceId, expectedRevision: 1 };
        await expect(inTx(tx => resourceService.validateSavedSecretHistoryTransferProofsInTx(tx, {
            accountId: owner.id, transfers: [proof] }))).resolves.toEqual({ status: 'ready' });
        await expect(inTx(tx => resourceService.validateSavedSecretHistoryTransferProofsInTx(tx, {
            accountId: owner.id, transfers: [{ ...proof, expectedRevision: 2 }] }))).resolves.toEqual({ status: 'conflict' });
        await expect(inTx(tx => resourceService.validateSavedSecretHistoryTransferProofsInTx(tx, {
            accountId: owner.id, transfers: [{ ...proof, savedSecretId: 'untransferred-source' }] }))).resolves.toEqual({ status: 'invalid' });
        const other = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        await expect(inTx(tx => resourceService.validateSavedSecretHistoryTransferProofsInTx(tx, {
            accountId: other.id, transfers: [proof] }))).resolves.toEqual({ status: 'invalid' });
    });

    it.each(['body', 'header', 'access', 'unchanged'] as const)('admits only the captured explicitly selected foreign Artifact (%s)', async changed => {
        const sourceSettings = JSON.stringify({ t: 'plain', v: { secrets: [{ id: 'source-secret', name: 'Token', kind: 'token',
            encryptedValue: { _isSecretValue: true, value: 'private' }, createdAt: 1, updatedAt: 1 }] } });
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settings: sourceSettings }, select: { id: true } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const artifactId = `foreign-profile-${changed}`;
        const body = { kind: 'launch-profile.v1', profile: { id: 'selected', name: 'Selected',
            environmentVariables: [], envVarRequirements: [{ name: 'TOKEN', kind: 'secret' }],
            createdAt: 1, updatedAt: 1 }, secretBindings: { TOKEN: 'source-secret' } };
        const bytes = (value: unknown) => new Uint8Array(Buffer.from(encodePlainArtifactStoredContent(value), 'base64'));
        expect(await inTx(tx => createArtifactTx(tx, { actorUserId: foreign.id, artifactId,
            header: bytes({ kind: 'launch-profile.v1', profileId: 'selected', name: 'Selected' }),
            body: bytes({ body: JSON.stringify(body) }), dataEncryptionKey: new Uint8Array(Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64')),
        }))).toMatchObject({ ok: true });
        await db.artifactAccountGrant.create({ data: { artifactId, accountId: owner.id, accessLevel: 'view', createdByAccountId: foreign.id } });
        const capturedStoredArtifact = await db.artifact.findUniqueOrThrow({ where: { id: artifactId } });
        const content = { t: 'plain' as const, v: { v: 1 as const, id: 'selected',
            definition: { kind: 'artifact' as const, artifactId }, enabled: true, promptStack: [], secretBindings: {} } };
        await db.userKVStore.createMany({ data: [
            { accountId: owner.id, key: buildProfilePhysicalKey('selected'), version: 0, value: new TextEncoder().encode(JSON.stringify(content)) },
            { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 0, value: null },
        ] });
        const referenceCensus = { accountMode: 'plain' as const, profiles: { referenceGuardRevision: 0, rows: [{ id: 'selected', revision: 0 }] },
            artifacts: [{ artifactId, headerVersion: 1, bodyVersion: 1 }] };
        if (changed === 'body') {
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: foreign.id, artifactId,
                body: { expectedVersion: 1, bytes: bytes({ body: JSON.stringify({ ...body, secretBindings: { TOKEN: 'another-secret' } }) }) },
            }))).toMatchObject({ ok: true });
        } else if (changed === 'header') {
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: foreign.id, artifactId,
                header: { expectedVersion: 1, bytes: bytes({ kind: 'launch-profile.v1', profileId: 'selected', name: 'Selected', title: 'Renamed header title' }) },
            }))).toMatchObject({ ok: true });
        } else if (changed === 'access') {
            await db.artifactAccountGrant.deleteMany({ where: { artifactId, accountId: owner.id } });
        }
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id,
            source: { kind: 'personal-saved-secret', secretId: 'source-secret' } });
        const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Token', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } },
            expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: {} }, referenceCensus,
            profileMutations: [{ id: 'selected', operation: 'update', expectedRevision: 0,
                content: { ...content, v: { ...content.v, secretBindings: { TOKEN: formatSharedSavedSecretRefV1(resourceId) } } },
                referencedSavedSecretIds: [formatSharedSavedSecretRefV1(resourceId)], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }],
                artifactRevision: { artifactId, headerVersion: 1, bodyVersion: 1 } }],
        }));
        if (changed === 'unchanged') {
            expect(result).toEqual({ ok: true, value: { resourceId, settingsVersion: 1 } });
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toMatchObject({ ownerAccountId: owner.id, revision: 1 });
            const row = await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: buildProfilePhysicalKey('selected') } } });
            expect(row?.version).toBe(1);
            expect(JSON.parse(new TextDecoder().decode(row?.value ?? new Uint8Array()))).toMatchObject({
                t: 'plain', v: { secretBindings: { TOKEN: formatSharedSavedSecretRefV1(resourceId) } },
            });
            const artifact = await db.artifact.findUnique({ where: { id: artifactId } });
            expect(artifact).toMatchObject({ accountId: foreign.id, headerVersion: 1, bodyVersion: 1 });
            expect(artifact?.body).toEqual(capturedStoredArtifact.body);
            expect(artifact?.header).toEqual(capturedStoredArtifact.header);
            expect(await db.artifactAccountGrant.findMany({ where: { artifactId, accountId: owner.id } })).toHaveLength(1);
            return;
        }
        expect(result).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: owner.id } })).toMatchObject({ settingsVersion: 0, settings: sourceSettings });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: buildProfilePhysicalKey('selected') } } })).toMatchObject({ version: 0 });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } } })).toMatchObject({ version: 0 });
    });

    it.each([true, false])('counts an explicitly selected Artifact binding, not automatic catalog display (selected=%s)', async selected => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const resourceId = `artifact-binding-secret-${selected}`;
        const reference = formatSharedSavedSecretRefV1(resourceId);
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Token', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } },
        }))).toMatchObject({ ok: true });
        const artifactId = `catalog-profile-${selected}`;
        const content = { kind: 'launch-profile.v1', profile: { id: 'selected', name: 'Selected',
            environmentVariables: [], envVarRequirements: [{ name: 'TOKEN', kind: 'secret' }],
            createdAt: 1, updatedAt: 1 }, secretBindings: { TOKEN: reference } };
        const bytes = (value: unknown) => new Uint8Array(Buffer.from(encodePlainArtifactStoredContent(value), 'base64'));
        expect(await inTx(tx => createArtifactTx(tx, { actorUserId: foreign.id, artifactId,
            header: bytes({ kind: 'launch-profile.v1', profileId: 'selected', name: 'Selected' }),
            body: bytes({ body: JSON.stringify(content) }), dataEncryptionKey: new Uint8Array(Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64')),
        }))).toMatchObject({ ok: true });
        await db.artifactAccountGrant.create({ data: { artifactId, accountId: owner.id, accessLevel: 'view', createdByAccountId: foreign.id } });
        if (selected) {
            await db.userKVStore.createMany({ data: [
                { accountId: owner.id, key: buildProfilePhysicalKey('selected'), version: 0, value: new TextEncoder().encode(JSON.stringify({
                    t: 'plain', v: { v: 1, id: 'selected', definition: { kind: 'artifact', artifactId },
                        enabled: true, promptStack: [], secretBindings: {} },
                })) },
                { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 0, value: null },
            ] });
        }
        const result = await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            expectedRevision: 1, expectedSettingsVersion: 0, referenceCensus: { accountMode: 'plain',
                profiles: { referenceGuardRevision: selected ? 0 : 'absent', rows: selected ? [{ id: 'selected', revision: 0 }] : [] },
                artifacts: selected ? [{ artifactId, headerVersion: 1, bodyVersion: 1 }] : [],
            },
        }));
        expect(result).toEqual(selected ? { ok: false, error: 'resource_in_use' } : { ok: true, value: { resourceId } });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toEqual(selected ? expect.objectContaining({ id: resourceId }) : null);
        expect(await db.artifactAccountGrant.findMany({ where: { artifactId, accountId: owner.id } })).toHaveLength(1);
        expect(await db.artifact.findUnique({ where: { id: artifactId } })).toMatchObject({ bodyVersion: 1 });
        if (!selected) {
            const record = { v: 1 as const, id: 'selected', definition: { kind: 'artifact' as const, artifactId },
                enabled: true, promptStack: [], secretBindings: {} };
            const before = await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } });
            const attached = await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id,
                expectedReferenceGuardRevision: 0, mutations: [{ id: record.id, operation: 'create', expectedRevision: 'absent',
                    content: { t: 'plain', v: record }, referencedSavedSecretIds: [],
                    artifactRevision: { artifactId, headerVersion: 1, bodyVersion: 1 } }] }));
            expect(attached).toMatchObject({ status: 'invalid-reference' });
            expect(await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } })).toEqual(before);
            expect(await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id,
                expectedReferenceGuardRevision: 0, mutations: [{ id: record.id, operation: 'create', expectedRevision: 'absent',
                    content: { t: 'plain', v: record }, referencedSavedSecretIds: [reference],
                    savedSecretRevisions: [{ resourceId, expectedRevision: 1 }],
                    artifactRevision: { artifactId, headerVersion: 1, bodyVersion: 1 } }] })))
                .toMatchObject({ status: 'invalid-reference' });
            expect(await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } })).toEqual(before);
            await db.artifactAccountGrant.deleteMany({ where: { artifactId, accountId: owner.id } });
            expect(await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id,
                expectedReferenceGuardRevision: 0, mutations: [{ id: record.id, operation: 'create', expectedRevision: 'absent',
                    content: { t: 'plain', v: { ...record, secretBindings: { TOKEN: null } } }, referencedSavedSecretIds: [],
                    artifactRevision: { artifactId, headerVersion: 1, bodyVersion: 1 } }] })))
                .toMatchObject({ status: 'invalid-reference' });
            expect(await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } })).toEqual(before);
            await db.artifactAccountGrant.create({ data: { artifactId, accountId: owner.id, accessLevel: 'view', createdByAccountId: foreign.id } });
            let revision = { artifactId, headerVersion: 1, bodyVersion: 1 };
            for (const changed of ['header', 'body'] as const) {
                const captured = revision;
                expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: foreign.id, artifactId,
                    ...(changed === 'header'
                        ? { header: { expectedVersion: 1, bytes: bytes({ kind: 'launch-profile.v1', profileId: 'selected', name: 'Selected', title: 'Renamed header title' }) } }
                        : { body: { expectedVersion: 1, bytes: bytes({ body: JSON.stringify({ ...content,
                            profile: { ...content.profile, updatedAt: 2 } }) }) } }),
                }))).toMatchObject({ ok: true });
                revision = { ...revision, ...(changed === 'header' ? { headerVersion: 2 } : { bodyVersion: 2 }) };
                expect(await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id,
                    expectedReferenceGuardRevision: 0, mutations: [{ id: record.id, operation: 'create', expectedRevision: 'absent',
                        content: { t: 'plain', v: { ...record, secretBindings: { TOKEN: null } } }, referencedSavedSecretIds: [],
                        artifactRevision: captured }] }))).toMatchObject({ status: 'invalid-reference' });
                expect(await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } })).toEqual(before);
            }
            // An explicit private none masks the unavailable shared default;
            // only the Artifact, not its missing secret, is selected afterward.
            expect(await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id,
                expectedReferenceGuardRevision: 0, mutations: [{ id: record.id, operation: 'create', expectedRevision: 'absent',
                    content: { t: 'plain', v: { ...record, secretBindings: { TOKEN: null } } }, referencedSavedSecretIds: [],
                    artifactRevision: revision }] })))
                .toMatchObject({ status: 'updated', referenceGuardRevision: 1 });
        }
    });

    it('promotes an inactive prepared row atomically while preserving unrelated personal staging bindings', async () => {
        const profile = AIBackendProfileSchema.parse({ id: 'prepared-personal-profile', name: 'Prepared',
            environmentVariables: [], envVarRequirements: [{ name: 'TOKEN', kind: 'secret' }, { name: 'OTHER', kind: 'secret' }],
            createdAt: 1, updatedAt: 1 });
        const secrets = ['source-secret', 'other-secret'].map(id => ({ id, name: id, kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: `${id}-private` }, createdAt: 1, updatedAt: 1 }));
        const bindings = { TOKEN: 'source-secret', OTHER: 'other-secret' };
        const raw = { profiles: [profile], secrets, secretBindingsByProfileId: { [profile.id]: bindings } };
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: raw }) }, select: { id: true } });
        const record = { v: 1 as const, id: profile.id, definition: { kind: 'legacy' as const, profile },
            enabled: true, promptStack: [], secretBindings: bindings };
        const inventory = [{ kind: 'account_row' as const, id: record.id, revision: 0 }];
        const control = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory };
        expect(await inTx(tx => mutateProfileTransferInTx(tx, { accountId: owner.id, mutation: {
            operation: 'prepare', expectedRevision: 'absent', sourceSettingsVersion: 0, inventory, content: { t: 'plain', v: control },
            imports: [{ id: record.id, operation: 'import', expectedRevision: 'absent', content: { t: 'plain', v: record },
                referencedSavedSecretIds: Object.values(bindings) }],
        } }))).toMatchObject({ status: 'updated', revision: 0 });
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: owner.id, source: { kind: 'personal-saved-secret', secretId: 'source-secret' } });
        const reference = formatSharedSavedSecretRefV1(resourceId);
        const rewritten = promotePersonalSavedSecretReference(raw, { secretId: 'source-secret', expectedUpdatedAt: 1,
            sharedSecretRef: reference }, { profileRecords: [record] });
        const nextRecord = rewritten.profileRecords?.[0];
        expect(nextRecord).toBeDefined();
        if (!nextRecord) throw new Error('canonical promotion must return the rewritten prepared Profile');
        const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'source-secret', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'source-secret', kind: 'token', value: 'source-secret-private' } },
            expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: rewritten.settings },
            referenceCensus: { accountMode: 'plain', profileTransferRevision: 0,
                profiles: { referenceGuardRevision: 0, rows: [{ id: record.id, revision: 0 }] } },
            profileMutations: [{ id: record.id, operation: 'import', expectedRevision: 0, content: { t: 'plain', v: nextRecord },
                referencedSavedSecretIds: Object.values(resolveEffectiveProfileSecretBindingsV1({}, nextRecord.secretBindings)),
                savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] }],
        }));
        expect(result).toEqual({ ok: true, value: { resourceId, settingsVersion: 1 } });
        const account = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
        expect(openPlainAccountSettingsDbValue({ accountId: owner.id, dbValue: account.settings })).toEqual({ t: 'plain', v: {
            ...raw, secrets: [secrets[1]], secretBindingsByProfileId: { [record.id]: { TOKEN: reference, OTHER: 'other-secret' } },
        } });
        const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner.id, key: buildProfilePhysicalKey(record.id) } } });
        expect(row.version).toBe(1);
        expect(JSON.parse(new TextDecoder().decode(row.value ?? new Uint8Array()))).toEqual({ t: 'plain', v: nextRecord });
        expect(nextRecord.secretBindings).toEqual({ TOKEN: reference, OTHER: 'other-secret' });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } } })).toMatchObject({ version: 1 });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toMatchObject({ ownerAccountId: owner.id, revision: 1 });
        // Resource attachment is not activation; S3 must reprepare the changed source inventory.
        expect(await inTx(tx => readProfileTransferControlInTx(tx, { accountId: owner.id }))).toMatchObject({
            status: 'present', revision: 0, envelope: { t: 'plain', v: control },
        });
    });

    it('does not treat stale predecessor Profile residue as a reference after the real control activates', async () => {
        const resourceId = 'active-profile-stale-source';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const profile = AIBackendProfileSchema.parse({ id: 'source-profile', name: 'Source', environmentVariables: [], createdAt: 1, updatedAt: 1 });
        const raw = { profiles: [profile], secretBindingsByProfileId: { 'source-profile': { TOKEN: ref } } };
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: raw }) }, select: { id: true } });
        await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Token', kind: 'token',
            encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } } }));
        const record = { v: 1 as const, id: profile.id, definition: { kind: 'legacy' as const, profile },
            enabled: true, promptStack: [], secretBindings: { TOKEN: ref } };
        const inventory = [{ kind: 'account_row' as const, id: profile.id, revision: 0 },
            { kind: 'saved_secret' as const, id: resourceId, revision: 1 }];
        const control = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory };
        expect(await inTx(tx => mutateProfileTransferInTx(tx, { accountId: owner.id, mutation: {
            operation: 'prepare', expectedRevision: 'absent', sourceSettingsVersion: 0, inventory, content: { t: 'plain', v: control },
            imports: [{ id: record.id, operation: 'import', expectedRevision: 'absent', content: { t: 'plain', v: record },
                referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] }],
        } }))).toMatchObject({ status: 'updated', revision: 0 });
        expect(await inTx(tx => mutateProfileTransferInTx(tx, { accountId: owner.id, mutation: {
            operation: 'activate', expectedRevision: 0, sourceSettingsVersion: 0, inventory,
            content: { t: 'plain', v: { ...control, phase: 'active' } },
        } }))).toMatchObject({ status: 'updated', revision: 1 });
        expect(await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id, expectedReferenceGuardRevision: 0,
            mutations: [{ id: record.id, operation: 'update', expectedRevision: 0,
                content: { t: 'plain', v: { ...record, secretBindings: {} } }, referencedSavedSecretIds: [] }],
        }))).toMatchObject({ status: 'updated', referenceGuardRevision: 1 });
        const result = await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            expectedRevision: 1, expectedSettingsVersion: 0, referenceCensus: { accountMode: 'plain', profileTransferRevision: 1,
                profiles: { referenceGuardRevision: 1, rows: [{ id: record.id, revision: 1 }] } },
        }));
        expect(result).toEqual({ ok: true, value: { resourceId } });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: owner.id } })).toMatchObject({ settingsVersion: 0 });
    });

    it('refuses source promotion overtaken by Profile activation at the same Settings version', async () => {
        const profile = AIBackendProfileSchema.parse({ id: 'source-control-profile', name: 'Source', environmentVariables: [], createdAt: 1, updatedAt: 1 });
        const raw = { profiles: [profile], secretBindingsByProfileId: {} };
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settings: JSON.stringify({ t: 'plain', v: raw }) }, select: { id: true } });
        const record = { v: 1 as const, id: profile.id, definition: { kind: 'legacy' as const, profile },
            enabled: true, promptStack: [], secretBindings: {} };
        const inventory = [{ kind: 'account_row' as const, id: profile.id, revision: 0 }];
        const control = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory };
        expect(await inTx(tx => mutateProfileTransferInTx(tx, { accountId: owner.id, mutation: {
            operation: 'prepare', expectedRevision: 'absent', sourceSettingsVersion: 0, inventory, content: { t: 'plain', v: control },
            imports: [{ id: record.id, operation: 'import', expectedRevision: 'absent', content: { t: 'plain', v: record }, referencedSavedSecretIds: [] }],
        } }))).toMatchObject({ status: 'updated', revision: 0 });
        const referenceCensus = { accountMode: 'plain' as const, profileTransferRevision: 0,
            profiles: { referenceGuardRevision: 0, rows: [{ id: profile.id, revision: 0 }] } };
        expect(await inTx(tx => mutateProfileTransferInTx(tx, { accountId: owner.id, mutation: {
            operation: 'activate', expectedRevision: 0, sourceSettingsVersion: 0, inventory,
            content: { t: 'plain', v: { ...control, phase: 'active' } },
        } }))).toMatchObject({ status: 'updated', revision: 1 });
        const resourceId = 'source-control-promotion';
        const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Token', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } },
            expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: { ...raw, secretBindingsByProfileId: { [profile.id]: { TOKEN: formatSharedSavedSecretRefV1(resourceId) } } } },
            referenceCensus, profileMutations: [],
        }));
        expect(result).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: owner.id } })).toMatchObject({ settingsVersion: 0 });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } } })).toMatchObject({ version: 0 });
    });

    it('refuses an E2EE phantom Profile reference inserted after a complete census', async () => {
        const material = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: material.account, select: { id: true } });
        await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId: 'phantom-reference', displayName: 'Token', kind: 'token',
            encryptionMode: 'e2ee', storedContent: sealTestResource('phantom-reference', 'Token'),
            keyEnvelopes: [{ recipientAccountId: owner.id, encryptedDataKey: sealTestDataKey(material.contentPublicKey),
                recipientContentPublicKeyFingerprint: material.fingerprint }],
        }));
        const captured = { accountMode: 'e2ee' as const, profiles: { referenceGuardRevision: 'absent' as const, rows: [] } };
        const content = sealProfileRecordContentV1({ mode: 'e2ee', material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(4) },
            record: { v: 1, id: 'inserted-profile', definition: { kind: 'artifact', artifactId: 'profile-artifact' },
                enabled: true, promptStack: [], secretBindings: { TOKEN: formatSharedSavedSecretRefV1('phantom-reference') } } });
        await db.userKVStore.createMany({ data: [
            { accountId: owner.id, key: buildProfilePhysicalKey('inserted-profile'), version: 0, value: new TextEncoder().encode(JSON.stringify(content)) },
            { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 0, value: null },
        ] });
        const result = await inTx(tx => deleteSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId: 'phantom-reference', expectedRevision: 1,
            expectedSettingsVersion: 0, referenceCensus: captured,
        }));
        expect(result).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.findUnique({ where: { id: 'phantom-reference' } })).not.toBeNull();
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY } } })).toMatchObject({ version: 0 });
    });

    it('requires an explicit opened non-Artifact declaration before writing an opaque Profile', async () => {
        const material = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: material.account, select: { id: true } });
        const id = 'opaque-inline-profile';
        const record = { v: 1 as const, id, definition: { kind: 'inline' as const, profile: {
            v: 2 as const, id, name: 'Opaque inline', extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
        } }, enabled: true, promptStack: [], secretBindings: {} };
        const content = sealProfileRecordContentV1({ mode: 'e2ee', material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(4) }, record });
        const mutation = { id, operation: 'create' as const, expectedRevision: 'absent' as const, content, referencedSavedSecretIds: [] };
        expect(await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id, mutations: [mutation] })))
            .toMatchObject({ status: 'invalid-reference' });
        expect(await db.userKVStore.count({ where: { accountId: owner.id } })).toBe(0);
        expect(await inTx(tx => mutateProfileRowsInTx(tx, { accountId: owner.id,
            mutations: [{ ...mutation, artifactRevision: null }] }))).toMatchObject({ status: 'updated', referenceGuardRevision: 0 });
        const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner.id, key: buildProfilePhysicalKey(id) } } });
        expect(JSON.parse(new TextDecoder().decode(row.value!))).toEqual(content);
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).settingsVersion).toBe(0);
    });

    it('does not create a promoted resource when a newly inserted Profile invalidates its census', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const content = { t: 'plain' as const, v: { v: 1 as const, id: 'inserted-profile',
            definition: { kind: 'artifact' as const, artifactId: 'profile-artifact' }, enabled: true,
            promptStack: [], secretBindings: {} } };
        await db.userKVStore.createMany({ data: [
            { accountId: owner.id, key: buildProfilePhysicalKey('inserted-profile'), version: 0, value: new TextEncoder().encode(JSON.stringify(content)) },
            { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 0, value: null },
        ] });
        const result = await inTx(tx => promoteSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId: 'phantom-promoted', displayName: 'Token', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'never-written' } },
            expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: {} },
            referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
            profileMutations: [],
        }));
        expect(result).toEqual({ ok: false, error: 'references_conflict' });
        expect(await db.savedSecretResource.findUnique({ where: { id: 'phantom-promoted' } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: owner.id } })).toMatchObject({ settingsVersion: 0 });
    });

    it("rolls back the resource, grants, and invalidation when the Settings CAS conflicts", async () => {
        const owner = await db.account.create({
            data: {
                encryptionMode: "plain",
                settings: JSON.stringify({ t: "plain", v: { secrets: [] } }),
                settingsVersion: 3,
            },
            select: { id: true },
        });
        const recipient = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });

        let abort: unknown = null;
        try {
            await inTx((tx) => promoteSavedSecretResourceInTx(tx, {
                accountId: owner.id,
                resourceId: "resource_atomic_conflict",
                displayName: "Shared token",
                kind: "token",
                encryptionMode: "plain",
                storedContent: {
                    t: "plain",
                    v: { v: 1, name: "Shared token", kind: "token", value: "never-committed" },
                },
                accountGrants: [recipient.id],
                expectedSettingsVersion: 1,
                nextSettings: { t: "plain", v: { secrets: [] } },
                referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
                profileMutations: [],
            }));
        } catch (error) {
            abort = error;
        }

        expect(abort).toBeInstanceOf(SavedSecretResourceTransactionAbort);
        expect(abort).toMatchObject({ error: "settings_conflict" });
        await expect(db.savedSecretResource.findUnique({
            where: { id: "resource_atomic_conflict" },
        })).resolves.toBeNull();
        await expect(db.savedSecretAccountGrant.count()).resolves.toBe(0);
        await expect(db.accountChange.count({
            where: { entityId: "resource_atomic_conflict" },
        })).resolves.toBe(0);
    });

    it('atomically rewrites private Profile bindings and validates the complete lost-response receipt', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const resourceId = 'private-row-promotion';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const record = { v: 1 as const, id: 'private-profile', definition: { kind: 'legacy' as const,
            profile: AIBackendProfileSchema.parse({ id: 'private-profile', name: 'Private', environmentVariables: [], createdAt: 1, updatedAt: 1 }) },
            enabled: true, promptStack: [], secretBindings: { TOKEN: 'personal-token' } };
        await db.userKVStore.createMany({ data: [
            { accountId: owner.id, key: buildProfilePhysicalKey(record.id), version: 3, value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: record })) },
            { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 6, value: null },
        ] });
        const input = { accountId: owner.id, resourceId, displayName: 'Token', kind: 'token' as const, encryptionMode: 'plain' as const,
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Token', kind: 'token' as const, value: 'private' } },
            expectedSettingsVersion: 0, nextSettings: { t: 'plain' as const, v: {} },
            referenceCensus: { accountMode: 'plain' as const, profiles: { referenceGuardRevision: 6, rows: [{ id: record.id, revision: 3 }] } },
            profileMutations: [{ id: record.id, operation: 'update' as const, expectedRevision: 3,
                content: { t: 'plain' as const, v: { ...record, secretBindings: { TOKEN: ref } } },
                referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] }] };
        await expect(inTx(tx => promoteSavedSecretResourceInTx(tx, input))).resolves.toEqual({ ok: true, value: { resourceId, settingsVersion: 1 } });
        const committed = await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } });
        expect(committed.find(row => row.key === buildProfilePhysicalKey(record.id))).toMatchObject({ version: 4 });
        expect(committed.find(row => row.key === PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY)).toMatchObject({ version: 7 });
        await expect(inTx(tx => promoteSavedSecretResourceInTx(tx, input))).resolves.toEqual({ ok: true, value: { resourceId, settingsVersion: 1 } });
        expect(await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } })).toEqual(committed);
        await expect(inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            expectedRevision: 1, expectedSettingsVersion: 1, referenceCensus: { accountMode: 'plain', profiles: {
                referenceGuardRevision: 7, rows: [{ id: record.id, revision: 4 }] } } }))).resolves.toEqual({ ok: false, error: 'resource_in_use' });
        expect(await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } })).toEqual(committed);
    });

    it('rolls back a newly created resource when a private binding resource revision is refused', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const resourceId = 'private-row-refusal';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const record = { v: 1 as const, id: 'private-profile', definition: { kind: 'legacy' as const,
            profile: AIBackendProfileSchema.parse({ id: 'private-profile', name: 'Private', environmentVariables: [], createdAt: 1, updatedAt: 1 }) },
            enabled: true, promptStack: [], secretBindings: { TOKEN: 'personal-token' } };
        await db.userKVStore.createMany({ data: [
            { accountId: owner.id, key: buildProfilePhysicalKey(record.id), version: 3, value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: record })) },
            { accountId: owner.id, key: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, version: 6, value: null },
        ] });
        const before = await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } });
        await expect(inTx(tx => promoteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, displayName: 'Token',
            kind: 'token', encryptionMode: 'plain', storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'private' } },
            expectedSettingsVersion: 0, nextSettings: { t: 'plain', v: {} },
            referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 6, rows: [{ id: record.id, revision: 3 }] } },
            profileMutations: [{ id: record.id, operation: 'update', expectedRevision: 3,
                content: { t: 'plain', v: { ...record, secretBindings: { TOKEN: ref } } }, referencedSavedSecretIds: [ref],
                savedSecretRevisions: [{ resourceId, expectedRevision: 2 }] }] }))).rejects.toMatchObject({ error: 'references_invalid' });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: owner.id } })).toMatchObject({ settingsVersion: 0 });
        expect(await db.userKVStore.findMany({ where: { accountId: owner.id }, orderBy: { key: 'asc' } })).toEqual(before);
    });

    it("returns the committed promotion on a lost-response retry without duplicating the mutable source", async () => {
        const resourceId = "resource_lost_response_retry";
        const personalSecretId = "personal_before_lost_response";
        const settings = {
            secrets: [{
                id: personalSecretId,
                name: "Shared token",
                kind: "token" as const,
                encryptedValue: { _isSecretValue: true as const, value: "promoted-value" },
                createdAt: 1,
                updatedAt: 7,
            }],
            secretBindingsByProfileId: {
                default: { API_TOKEN: personalSecretId },
            },
        };
        const nextSettings = promotePersonalSavedSecretReference(settings, {
            secretId: personalSecretId,
            expectedUpdatedAt: 7,
            sharedSecretRef: formatSharedSavedSecretRefV1(resourceId),
        }).settings;
        const owner = await db.account.create({
            data: {
                encryptionMode: "plain",
                settingsVersion: 1,
                settings: JSON.stringify({ t: "plain", v: settings }),
            },
            select: { id: true },
        });
        const recipient = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        const controller = await db.machine.create({ data: { id: 'promotion-controller', accountId: owner.id, metadata: '{}',
            installationId: 'promotion-install' } });
        const otherController = await db.machine.create({ data: { id: 'promotion-other-controller', accountId: recipient.id, metadata: '{}',
            installationId: 'promotion-other-install' } });
        const team = await db.team.create({ data: { name: 'Setup team' } });
        const environment = { toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' }, setupScript: 'echo setup',
            secretRefs: { v: 1, bindings: { TOKEN: { ref: personalSecretId }, UNRELATED: { ref: 'unrelated-personal' } } } };
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const preset = await db.managedMachinePreset.create({ data: { homeId: 'promotion-home', name: 'Team preset', teamId: team.id,
            launch, controllerMachineId: controller.id, controllerInstallationId: 'promotion-install', environment, revision: 4 } });
        const foreignPreset = await db.managedMachinePreset.create({ data: { homeId: 'promotion-home', name: 'Other account',
            custodianAccountId: recipient.id, launch, controllerMachineId: otherController.id,
            controllerInstallationId: 'promotion-other-install', environment } });
        const managed = await db.managedMachine.create({ data: { homeId: 'promotion-home', custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: 'promotion-install', launch, presetId: preset.id, presetRevision: 4,
            admittedActionRequestId: 'promotion-setup', admittedInput: {}, allocation: 'may-exist',
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            environmentSetup: { state: 'pending', environment } } });
        const input = {
            accountId: owner.id,
            resourceId,
            displayName: "Shared token",
            kind: "token" as const,
            encryptionMode: "plain" as const,
            storedContent: {
                t: "plain" as const,
                v: { v: 1 as const, name: "Shared token", kind: "token" as const, value: "promoted-value" },
            },
            expectedSettingsVersion: 1,
            nextSettings: { t: "plain" as const, v: nextSettings },
            referenceCensus: { accountMode: 'plain' as const, profiles: { referenceGuardRevision: 'absent' as const, rows: [] } },
            profileMutations: [],
            personalSecretPromotions: [{ personalSecretId, resourceId }],
        };
        const unmapped = { ...input, personalSecretPromotions: undefined };
        expect(await inTx(tx => promoteSavedSecretResourceInTx(tx, unmapped))).toEqual({ ok: false, error: 'references_invalid' });
        expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: preset.id } })).toMatchObject({ revision: 4, environment });
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ settingsVersion: 1 });

        await expect(inTx((tx) => promoteSavedSecretResourceInTx(tx, input))).resolves.toEqual({
            ok: true,
            value: { resourceId, settingsVersion: 2 },
        });
        const rewritten = { ...environment, secretRefs: { ...environment.secretRefs,
            bindings: { ...environment.secretRefs.bindings, TOKEN: { ref: formatSharedSavedSecretRefV1(resourceId), revision: 1 } } } };
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: preset.id } })).toMatchObject({ revision: 5, environment: rewritten });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } })).toMatchObject({
            presetRevision: 4, environmentSetup: { state: 'pending', environment: rewritten } });
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: foreignPreset.id } })).toMatchObject({ revision: 0, environment });
        // Simulate a client retry after the first committed response was lost.
        await expect(inTx((tx) => promoteSavedSecretResourceInTx(tx, input))).resolves.toEqual({
            ok: true,
            value: { resourceId, settingsVersion: 2 },
        });
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: preset.id } })).toMatchObject({ revision: 5, environment: rewritten });
        await expect(inTx((tx) => promoteSavedSecretResourceInTx(tx, {
            ...input,
            accountGrants: [recipient.id],
        }))).resolves.toEqual({ ok: false, error: "resource_changed" });

        await expect(db.savedSecretResource.count({ where: { id: resourceId } })).resolves.toBe(1);
        await expect(db.accountSettingsSnapshot.count({ where: { accountId: owner.id } })).resolves.toBe(2);
        const account = await db.account.findUniqueOrThrow({
            where: { id: owner.id },
            select: { settingsVersion: true, settings: true },
        });
        expect(account.settingsVersion).toBe(2);
        const currentContent = openPlainAccountSettingsDbValue({
            accountId: owner.id,
            dbValue: account.settings,
        });
        expect(currentContent).toEqual(input.nextSettings);
        expect(JSON.stringify(currentContent)).not.toContain(personalSecretId);
        expect(JSON.stringify(currentContent)).toContain(formatSharedSavedSecretRefV1(resourceId));
    });

    it("server-seals a Plain resource at rest while returning its explicit Plain envelope to its owner", async () => {
        const owner = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });

        const created = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_plain_sealed",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "must-not-be-readable-at-rest" },
            },
        }));
        expect(created.ok).toBe(true);

        const stored = await db.savedSecretResource.findUniqueOrThrow({
            where: { id: "resource_plain_sealed" },
            select: { storedContent: true },
        });
        expect(stored.storedContent).not.toContain("must-not-be-readable-at-rest");
        expect(JSON.parse(stored.storedContent)).toMatchObject({
            v: 1,
            storage: "server_sealed_json_v1",
        });

        const materials = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, owner.id));
        expect(materials).toHaveLength(1);
        expect(materials[0] && "resourceId" in materials[0]).toBe(true);
        if (!materials[0] || !("resourceId" in materials[0])) throw new Error("Expected healthy material projection");
        expect(materials[0]?.storedContent).toEqual({
            t: "plain",
            v: { v: 1, name: "Shared token", kind: "token", value: "must-not-be-readable-at-rest" },
        });
    });

    it("rejects a non-canonical resource id before writing any row", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const result = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: " resource_with_space",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "value" },
            },
        }));
        expect(result).toEqual({ ok: false, error: "invalid_resource" });
        await expect(db.savedSecretResource.count()).resolves.toBe(0);
    });

    it("rejects an unrelated Account instead of treating an existing ID as grant eligibility", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const unrelated = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });

        const result = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_unrelated_account",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "value" },
            },
            accountGrants: [unrelated.id],
        }));

        expect(result).toEqual({ ok: false, error: "forbidden" });
        await expect(db.savedSecretResource.count()).resolves.toBe(0);
    });

    it("persists all 257 eligible Account grants without truncation", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const recipientIds = Array.from({ length: 257 }, (_, index) => `saved-secret-recipient-${index}`);
        await db.account.createMany({
            data: recipientIds.map((id) => ({ id, encryptionMode: "plain" })),
        });
        await db.userRelationship.createMany({
            data: recipientIds.map((toUserId) => ({ fromUserId: owner.id, toUserId, status: "friend" })),
        });

        const result = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_complete_257_account_grants",
            displayName: "Complete audience",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Complete audience", kind: "token", value: "secret" },
            },
            accountGrants: recipientIds,
        }));

        expect(result).toMatchObject({ ok: true });
        await expect(db.savedSecretAccountGrant.count({
            where: { resourceId: "resource_complete_257_account_grants" },
        })).resolves.toBe(257);
        await expect(db.savedSecretAccountGrant.findMany({
            where: { resourceId: "resource_complete_257_account_grants" },
            select: { accountId: true },
        })).resolves.toEqual(expect.arrayContaining(recipientIds.map((accountId) => ({ accountId }))));
    });

    it("rejects an unrelated Team and Group instead of treating membership enumeration as authority", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const unrelated = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const team = await db.team.create({ data: { name: "Unrelated team" }, select: { id: true } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: unrelated.id, role: "owner" },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Unrelated group", nameKey: "unrelated-group" },
            select: { id: true },
        });

        for (const audience of [{ teamGrants: [team.id] }, { groupGrants: [group.id] }]) {
            const result = await inTx((tx) => createSavedSecretResourceInTx(tx, {
                accountId: owner.id,
                resourceId: audience.teamGrants ? "resource_unrelated_team" : "resource_unrelated_group",
                displayName: "Shared token",
                kind: "token",
                encryptionMode: "plain",
                storedContent: {
                    t: "plain",
                    v: { v: 1, name: "Shared token", kind: "token", value: "value" },
                },
                ...audience,
            }));
            expect(result).toEqual({ ok: false, error: "forbidden" });
        }
        await expect(db.savedSecretResource.count()).resolves.toBe(0);
    });

    it("allows active members but denies Guests from sharing their secret with a Team or its Group", async () => {
        const member = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const guest = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const team = await db.team.create({ data: { name: "Credential audience" }, select: { id: true } });
        await db.teamMembership.createMany({
            data: [
                { teamId: team.id, accountId: member.id, role: "member" },
                { teamId: team.id, accountId: guest.id, role: "guest" },
            ],
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Credential group", nameKey: "credential-group" },
            select: { id: true },
        });

        for (const audience of [{ teamGrants: [team.id] }, { groupGrants: [group.id] }]) {
            const guestResult = await inTx((tx) => createSavedSecretResourceInTx(tx, {
                accountId: guest.id,
                resourceId: audience.teamGrants ? "resource_guest_team" : "resource_guest_group",
                displayName: "Shared token",
                kind: "token",
                encryptionMode: "plain",
                storedContent: {
                    t: "plain",
                    v: { v: 1, name: "Shared token", kind: "token", value: "value" },
                },
                ...audience,
            }));
            expect(guestResult).toEqual({ ok: false, error: "forbidden" });

            const memberResult = await inTx((tx) => createSavedSecretResourceInTx(tx, {
                accountId: member.id,
                resourceId: audience.teamGrants ? "resource_member_team" : "resource_member_group",
                displayName: "Shared token",
                kind: "token",
                encryptionMode: "plain",
                storedContent: {
                    t: "plain",
                    v: { v: 1, name: "Shared token", kind: "token", value: "value" },
                },
                ...audience,
            }));
            expect(memberResult).toMatchObject({ ok: true });
        }

        await db.teamMembership.update({
            where: { teamId_accountId: { teamId: team.id, accountId: member.id } },
            data: { status: "suspended" },
        });
        const revokedResult = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: member.id,
            resourceId: "resource_revoked_member_team",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "value" },
            },
            teamGrants: [team.id],
        }));
        expect(revokedResult).toEqual({ ok: false, error: "forbidden" });
    });

    it("withholds a restricted Team's shared secret from a member whose credential does not qualify", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const member = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const team = await db.team.create({
            data: {
                name: "Restricted audience",
                authenticationPolicy: { v: 1, mode: "restricted", accepted: [ACCEPTED_EMAIL_PASSWORD] },
            },
            select: { id: true },
        });
        await db.teamMembership.createMany({
            data: [
                { teamId: team.id, accountId: custodian.id, role: "owner" },
                { teamId: team.id, accountId: member.id, role: "member" },
            ],
        });
        await db.accountIdentity.create({
            data: { accountId: custodian.id, provider: "email", providerUserId: "owner@example.test", profile: {} },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: custodian.id,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("owner password factor")),
                },
            },
        });
        await db.accountIdentity.create({
            data: { accountId: member.id, provider: "email", providerUserId: "member@example.test", profile: {} },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: member.id,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("member password factor")),
                },
            },
        });

        const qualified = {
            env: { ...process.env, ...HOME_OFFERS_EMAIL_PASSWORD },
            authenticationAuthority: "present_user" as const,
            authenticationEvidence: EMAIL_PASSWORD_EVIDENCE,
        };
        const unqualified = {
            env: { ...process.env, ...HOME_OFFERS_EMAIL_PASSWORD },
            authenticationAuthority: "present_user" as const,
            authenticationEvidence: undefined,
        };

        expect(await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: custodian.id,
            authentication: qualified,
            resourceId: "resource_restricted_team",
            displayName: "Team token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Team token", kind: "token", value: "team-value" } },
            teamGrants: [team.id],
        }))).toMatchObject({ ok: true });
        expect(await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: custodian.id,
            authentication: qualified,
            resourceId: "resource_direct_grant",
            displayName: "Direct token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Direct token", kind: "token", value: "direct-value" } },
            accountGrants: [member.id],
        }))).toMatchObject({ ok: true });

        // The member is structurally an active non-guest member of the Team, but
        // presents no evidence of the accepted method.
        const withoutEvidence = await inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, member.id, unqualified));
        expect(withoutEvidence.map((entry) => (entry.materialStatus === "resource_corrupt" ? null : entry.ref))).toEqual([formatSharedSavedSecretRefV1("resource_direct_grant")]);
        const materialsWithoutEvidence = await inTx((tx) =>
            listSavedSecretResourceMaterialsForAccountInTx(tx, member.id, unqualified));
        expect(materialsWithoutEvidence.map((row) => (row.entry.materialStatus === "resource_corrupt" ? null : row.entry.ref))).toEqual([formatSharedSavedSecretRefV1("resource_direct_grant")]);

        const withEvidence = await inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, member.id, qualified));
        expect([...withEvidence.map((entry) => (entry.materialStatus === "resource_corrupt" ? null : entry.ref))].sort())
            .toEqual([
                formatSharedSavedSecretRefV1("resource_direct_grant"),
                formatSharedSavedSecretRefV1("resource_restricted_team"),
            ].sort());

        // The custodian's own resources never depend on the Team credential.
        const ownerView = await inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, custodian.id, unqualified));
        expect([...ownerView.map((entry) => (entry.materialStatus === "resource_corrupt" ? null : entry.ref))].sort())
            .toEqual([
                formatSharedSavedSecretRefV1("resource_direct_grant"),
                formatSharedSavedSecretRefV1("resource_restricted_team"),
            ].sort());

        // A Team audience cannot be written with an unqualified credential either.
        expect(await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: member.id,
            authentication: unqualified,
            resourceId: "resource_member_unqualified_team",
            displayName: "Member token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Member token", kind: "token", value: "member-value" } },
            teamGrants: [team.id],
        }))).toEqual({ ok: false, error: "forbidden" });
    });

    it("names only the restricted arms the caller's credential actually qualified in recipient provenance", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const member = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const team = await db.team.create({
            data: {
                name: "Provenance restricted",
                authenticationPolicy: { v: 1, mode: "restricted", accepted: [ACCEPTED_EMAIL_PASSWORD] },
            },
            select: { id: true },
        });
        const custodianMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: custodian.id, role: "owner" },
            select: { id: true },
        });
        const memberMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: member.id, role: "member" },
            select: { id: true },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Provenance group", nameKey: "provenance-group" },
            select: { id: true },
        });
        await db.teamGroupMembership.createMany({
            data: [
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: custodianMembership.id },
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: memberMembership.id },
            ],
        });
        for (const [accountId, address, factor] of [
            [custodian.id, "provenance-owner@example.test", "owner password factor"],
            [member.id, "provenance-member@example.test", "member password factor"],
        ] as const) {
            await db.accountIdentity.create({
                data: { accountId, provider: "email", providerUserId: address, profile: {} },
            });
            await db.accountPasswordCredential.create({
                data: {
                    accountId,
                    credential: {
                        v: 1,
                        kind: "plain_password_hash",
                        hash: await hashPasswordMaterial(new TextEncoder().encode(factor)),
                    },
                },
            });
        }

        const qualified = {
            env: { ...process.env, ...HOME_OFFERS_EMAIL_PASSWORD },
            authenticationAuthority: "present_user" as const,
            authenticationEvidence: EMAIL_PASSWORD_EVIDENCE,
        };
        const unqualified = { ...qualified, authenticationEvidence: undefined };

        expect(await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: custodian.id,
            authentication: qualified,
            resourceId: "resource_multi_arm",
            displayName: "Multi-arm token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Multi-arm token", kind: "token", value: "multi-value" } },
            accountGrants: [member.id],
            teamGrants: [team.id],
            groupGrants: [group.id],
        }))).toMatchObject({ ok: true });

        // The direct grant keeps the material authorized, so the row is still
        // listed. The Team and Group arms are exactly what the current
        // credential failed to qualify, so naming them would disclose a
        // restricted Team's identity and this resource's relationship to it.
        const [withoutEvidence] = await inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, member.id, unqualified));
        if (!withoutEvidence || withoutEvidence.materialStatus === "resource_corrupt") throw new Error("expected the directly granted row");
        expect(withoutEvidence.accessSources).toEqual([{ kind: "account" }]);
        const [materialWithoutEvidence] = await inTx((tx) =>
            listSavedSecretResourceMaterialsForAccountInTx(tx, member.id, unqualified));
        if (!materialWithoutEvidence || materialWithoutEvidence.entry.materialStatus === "resource_corrupt") throw new Error("expected the directly granted material");
        expect(materialWithoutEvidence.entry.accessSources).toEqual([{ kind: "account" }]);

        const [withEvidence] = await inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, member.id, qualified));
        if (!withEvidence || withEvidence.materialStatus === "resource_corrupt") throw new Error("expected the qualified row");
        expect(withEvidence.accessSources).toEqual([
            { kind: "account" },
            { kind: "team", teamId: team.id, name: "Provenance restricted" },
            { kind: "group", teamId: team.id, teamName: "Provenance restricted", groupId: group.id, name: "Provenance group" },
        ]);

        // The custodian owns the resource: their audience projection is the
        // Team roster they wrote and never depends on their own credential.
        const [ownerView] = await inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, custodian.id, unqualified));
        if (!ownerView || ownerView.materialStatus === "resource_corrupt") throw new Error("expected the owner row");
        expect(ownerView.accessSources).toEqual([]);
        expect(ownerView.audience).toMatchObject({
            teams: [{ kind: "team", teamId: team.id, name: "Provenance restricted" }],
            groups: [{ kind: "group", teamId: team.id, teamName: "Provenance restricted", groupId: group.id, name: "Provenance group" }],
        });
    });

    it("stops authorizing a shared secret and its material through an archived Group or archived Team", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const member = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const restricted = await db.team.create({
            data: {
                name: "Restricted arm",
                authenticationPolicy: { v: 1, mode: "restricted", accepted: [ACCEPTED_EMAIL_PASSWORD] },
            },
            select: { id: true },
        });
        const inherited = await db.team.create({ data: { name: "Inherited arm" }, select: { id: true } });
        await db.teamMembership.createMany({
            data: [
                { teamId: restricted.id, accountId: custodian.id, role: "owner" },
                { teamId: restricted.id, accountId: member.id, role: "member" },
            ],
        });
        const custodianInherited = await db.teamMembership.create({
            data: { teamId: inherited.id, accountId: custodian.id, role: "owner" },
            select: { id: true },
        });
        const memberInherited = await db.teamMembership.create({
            data: { teamId: inherited.id, accountId: member.id, role: "member" },
            select: { id: true },
        });
        const group = await db.teamGroup.create({
            data: { teamId: inherited.id, name: "Inherited group", nameKey: "inherited-group" },
            select: { id: true },
        });
        await db.teamGroupMembership.createMany({
            data: [
                { teamId: inherited.id, teamGroupId: group.id, teamMembershipId: custodianInherited.id },
                { teamId: inherited.id, teamGroupId: group.id, teamMembershipId: memberInherited.id },
            ],
        });
        for (const [accountId, address, factor] of [
            [custodian.id, "archived-owner@example.test", "owner password factor"],
            [member.id, "archived-member@example.test", "member password factor"],
        ] as const) {
            await db.accountIdentity.create({
                data: { accountId, provider: "email", providerUserId: address, profile: {} },
            });
            await db.accountPasswordCredential.create({
                data: {
                    accountId,
                    credential: {
                        v: 1,
                        kind: "plain_password_hash",
                        hash: await hashPasswordMaterial(new TextEncoder().encode(factor)),
                    },
                },
            });
        }

        const qualified = {
            env: { ...process.env, ...HOME_OFFERS_EMAIL_PASSWORD },
            authenticationAuthority: "present_user" as const,
            authenticationEvidence: EMAIL_PASSWORD_EVIDENCE,
        };
        const unqualified = { ...qualified, authenticationEvidence: undefined };

        expect(await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: custodian.id,
            authentication: qualified,
            resourceId: "resource_archived_arm",
            displayName: "Archived arm token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Archived arm token", kind: "token", value: "archived-value" } },
            teamGrants: [restricted.id],
            groupGrants: [group.id],
        }))).toMatchObject({ ok: true });

        const listedRefs = async (authentication: typeof qualified | typeof unqualified) => {
            const [entries, materials] = await Promise.all([
                inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, member.id, authentication)),
                inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, member.id, authentication)),
            ]);
            return {
                catalog: entries.map((entry) => (entry.materialStatus === "resource_corrupt" ? null : entry.ref)),
                materials: materials.map((row) => (row.entry.materialStatus === "resource_corrupt" ? null : row.entry.ref)),
            };
        };

        // The unqualified member reaches the row only through the inherited-policy
        // Group; the restricted Team arm never qualifies.
        expect(await listedRefs(unqualified)).toEqual({
            catalog: [formatSharedSavedSecretRefV1("resource_archived_arm")],
            materials: [formatSharedSavedSecretRefV1("resource_archived_arm")],
        });

        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        expect(await listedRefs(unqualified)).toEqual({ catalog: [], materials: [] });

        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
        await db.team.update({ where: { id: inherited.id }, data: { archivedAt: new Date() } });
        expect(await listedRefs(unqualified)).toEqual({ catalog: [], materials: [] });

        // A direct grant still authorizes the row while the Group arm is archived,
        // and provenance never names the archived Group.
        await db.savedSecretAccountGrant.create({
            data: {
                resourceId: "resource_archived_arm",
                accountId: member.id,
                createdByAccountId: custodian.id,
            },
        });
        const [directOnly] = await inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, member.id, unqualified));
        if (!directOnly || directOnly.materialStatus === "resource_corrupt") throw new Error("expected the directly granted row");
        expect(directOnly.accessSources).toEqual([{ kind: "account" }]);
    });

    it("removes Group-granted Saved Secret access when the Account is suspended", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const member = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const team = await db.team.create({ data: { name: "Suspension audience" }, select: { id: true } });
        const ownerMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner.id, role: "owner" },
            select: { id: true },
        });
        const memberMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: member.id, role: "member" },
            select: { id: true },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Suspension group", nameKey: "suspension-group" },
            select: { id: true },
        });
        await db.teamGroupMembership.createMany({
            data: [
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: ownerMembership.id },
                { teamId: team.id, teamGroupId: group.id, teamMembershipId: memberMembership.id },
            ],
        });

        await expect(inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_suspended_group_member",
            displayName: "Suspension token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: { t: "plain", v: { v: 1, name: "Suspension token", kind: "token", value: "suspension-value" } },
            groupGrants: [group.id],
        }))).resolves.toMatchObject({ ok: true });

        const listRefs = async () => {
            const [catalog, materials] = await Promise.all([
                inTx((tx) => listSavedSecretResourcesForAccountInTx(tx, member.id)),
                inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, member.id)),
            ]);
            return {
                catalog: catalog.map((entry) => ('ref' in entry ? entry.ref : null)),
                materials: materials.map((entry) => ('ref' in entry.entry ? entry.entry.ref : null)),
            };
        };

        expect(await listRefs()).toEqual({
            catalog: [formatSharedSavedSecretRefV1("resource_suspended_group_member")],
            materials: [formatSharedSavedSecretRefV1("resource_suspended_group_member")],
        });

        await db.account.update({ where: { id: member.id }, data: { status: "suspended" } });
        expect(await listRefs()).toEqual({ catalog: [], materials: [] });

        await db.account.update({ where: { id: member.id }, data: { status: "active" } });
        expect(await listRefs()).toEqual({
            catalog: [formatSharedSavedSecretRefV1("resource_suspended_group_member")],
            materials: [formatSharedSavedSecretRefV1("resource_suspended_group_member")],
        });
    });

    it("replaces explicit grants under one owner-only resource revision CAS", async () => {
        const [owner, firstRecipient, secondRecipient] = await Promise.all([
            db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } }),
            db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } }),
            db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } }),
        ]);
        const team = await db.team.create({ data: { name: "Grant eligibility" }, select: { id: true } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: firstRecipient.id, role: "member" },
            { teamId: team.id, accountId: secondRecipient.id, role: "member" },
        ] });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_grant_cas",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret" },
            },
        }));
        const added = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_grant_cas",
            expectedRevision: 1,
            accountGrants: [firstRecipient.id],
            teamGrants: [],
            groupGrants: [],
        }));
        expect(added).toEqual({ ok: true, value: { resourceId: "resource_grant_cas", revision: 2 } });
    });

    it("degrades a mixed E2EE audience per recipient without rejecting its Plain recipient", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const recipientMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const encryptedRecipient = await db.account.create({ data: recipientMaterial.account, select: { id: true } });
        const plainRecipient = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await db.userRelationship.createMany({ data: [
            { fromUserId: owner.id, toUserId: encryptedRecipient.id, status: "friend" },
            { fromUserId: owner.id, toUserId: plainRecipient.id, status: "friend" },
        ] });

        const created = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mixed_mode",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource("resource_mixed_mode"),
            accountGrants: [encryptedRecipient.id, plainRecipient.id],
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }, {
                recipientAccountId: encryptedRecipient.id,
                encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
            }],
        }));

        expect(created).toMatchObject({ ok: true });
        const encrypted = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, encryptedRecipient.id));
        const plain = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, plainRecipient.id));
        expect(encrypted[0]?.entry.materialStatus).toBe("ready");
        expect(plain[0]?.entry.materialStatus).toBe("recipient_mode_unsupported");
    });

    it("atomically adds current E2EE recipient material with the audience revision", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const recipientMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const recipient = await db.account.create({ data: recipientMaterial.account, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_grant_material",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource("resource_grant_material"),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }],
        }));

        const changed = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_grant_material",
            expectedRevision: 1,
            accountGrants: [recipient.id],
            teamGrants: [],
            groupGrants: [],
            keyEnvelopes: [{
                recipientAccountId: recipient.id,
                encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
            }],
        }));

        expect(changed).toEqual({
            ok: true,
            value: { resourceId: "resource_grant_material", revision: 2 },
        });
        const material = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(material[0]).toMatchObject({
            resourceId: "resource_grant_material",
            entry: { materialStatus: "ready", revision: 2 },
            recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
        });
    });

    it("matches the stored envelope fingerprint to the caller's current verified binding", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const recipientMaterial = createE2eeAccountMaterial();
        const replacementMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const recipient = await db.account.create({ data: recipientMaterial.account, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_stale_envelope",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource("resource_stale_envelope"),
            accountGrants: [recipient.id],
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }, {
                recipientAccountId: recipient.id,
                encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
            }],
        }));

        const current = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(current[0]?.entry.materialStatus).toBe("ready");
        await db.account.update({
            where: { id: recipient.id },
            data: {
                publicKey: replacementMaterial.account.publicKey,
                contentPublicKey: replacementMaterial.account.contentPublicKey,
                contentPublicKeySig: replacementMaterial.account.contentPublicKeySig,
            },
        });

        const stale = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(stale[0]?.entry.materialStatus).toBe("preparing_encrypted_access");
    });

    it("repairs newly eligible E2EE recipient material at the exact resource revision", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const recipientMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const recipient = await db.account.create({ data: recipientMaterial.account, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_envelope_repair",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource("resource_envelope_repair"),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }],
        }));
        await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_envelope_repair",
            expectedRevision: 1,
            accountGrants: [recipient.id],
            teamGrants: [],
            groupGrants: [],
        }));

        const repaired = await inTx((tx) => repairSavedSecretResourceKeyEnvelopesInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_envelope_repair",
            expectedRevision: 2,
            keyEnvelopes: [{
                recipientAccountId: recipient.id,
                encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
            }],
        }));

        expect(repaired).toEqual({
            ok: true,
            value: { resourceId: "resource_envelope_repair", revision: 2 },
        });
        expect((await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id)))[0])
            .toMatchObject({ entry: { revision: 2, materialStatus: "ready" } });
        await expect(inTx((tx) => repairSavedSecretResourceKeyEnvelopesInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_envelope_repair",
            expectedRevision: 1,
            keyEnvelopes: [],
        }))).resolves.toEqual({ ok: false, error: "resource_changed" });
    });

    it("rejects an E2EE envelope that does not match the recipient's current verified binding", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });

        const result = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_wrong_envelope_binding",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource("resource_wrong_envelope_binding"),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            }],
        }));

        expect(result).toEqual({ ok: false, error: "invalid_resource" });
        await expect(db.savedSecretResource.findUnique({
            where: { id: "resource_wrong_envelope_binding" },
        })).resolves.toBeNull();
    });

    it("isolates malformed resource content and invalid recipient bindings from healthy catalog rows", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const recipientMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const recipient = await db.account.create({ data: recipientMaterial.account, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        for (const resourceId of ["resource_binding_repair", "resource_healthy_sibling"]) {
            await inTx((tx) => createSavedSecretResourceInTx(tx, {
                accountId: owner.id,
                resourceId,
                displayName: resourceId,
                kind: "token",
                encryptionMode: "e2ee",
                storedContent: sealTestResource(resourceId, resourceId),
                accountGrants: [recipient.id],
                keyEnvelopes: [{
                    recipientAccountId: owner.id,
                    encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                    recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
                }, {
                    recipientAccountId: recipient.id,
                    encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                    recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
                }],
            }));
        }
        await db.savedSecretResource.update({
            where: { id: "resource_binding_repair" },
            data: { storedContent: "malformed-at-rest-container" },
        });

        const beforeBindingDamage = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(beforeBindingDamage.find((row) => row.entry.materialStatus === "resource_corrupt")?.entry)
            .toEqual({ materialStatus: "resource_corrupt", relationship: "recipient", repair: null });
        expect(beforeBindingDamage.find((row) => "resourceId" in row && row.resourceId === "resource_healthy_sibling")?.entry.materialStatus)
            .toBe("ready");

        await db.account.update({
            where: { id: recipient.id },
            data: { contentPublicKeySig: null },
        });
        const afterBindingDamage = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(afterBindingDamage.find((row) => "resourceId" in row && row.resourceId === "resource_healthy_sibling")?.entry.materialStatus)
            .toBe("update_required");
    });

    it("projects malformed retained rows as owner-repairable and recipient-safe without hiding healthy siblings", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_healthy_next_to_corrupt",
            displayName: "Healthy sibling",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Healthy sibling", kind: "token", value: "healthy-secret" },
            },
            accountGrants: [recipient.id],
        }));
        const malformedResourceId = " malformed-retained-id ";
        await db.savedSecretResource.create({
            data: {
                id: malformedResourceId,
                ownerAccountId: owner.id,
                displayName: "Must not leak to recipient",
                kind: "token",
                encryptionMode: "plain",
                revision: 3,
                storedContent: "malformed-at-rest-container",
                accountGrants: {
                    create: { accountId: recipient.id, createdByAccountId: owner.id },
                },
            },
        });

        const ownerRows = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, owner.id));
        expect(ownerRows).toHaveLength(2);
        expect(ownerRows).toContainEqual(expect.objectContaining({
            entry: {
                materialStatus: "resource_corrupt",
                relationship: "owner",
                repair: {
                    kind: "delete_resource",
                    resourceId: malformedResourceId,
                    expectedRevision: 3,
                },
            },
        }));
        expect(ownerRows.some((row) => "resourceId" in row && row.resourceId === "resource_healthy_next_to_corrupt")).toBe(true);

        const recipientRows = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(recipientRows).toHaveLength(2);
        const corruptRecipientRow = recipientRows.find((row) => row.entry.materialStatus === "resource_corrupt");
        expect(corruptRecipientRow).toEqual({
            entry: {
                materialStatus: "resource_corrupt",
                relationship: "recipient",
                repair: null,
            },
        });
        expect(JSON.stringify(corruptRecipientRow)).not.toContain(malformedResourceId);
        expect(JSON.stringify(corruptRecipientRow)).not.toContain("Must not leak to recipient");
        expect(recipientRows.some((row) => "resourceId" in row && row.resourceId === "resource_healthy_next_to_corrupt")).toBe(true);
    });

    it("converts an owned E2EE resource to Plain in place, keeping its identity, audience and revision line", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const ownerMaterial = createE2eeAccountMaterial();
        const recipientMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const recipient = await db.account.create({ data: recipientMaterial.account, select: { id: true } });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_plain",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource("resource_mode_to_plain"),
            accountGrants: [recipient.id],
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }, {
                recipientAccountId: recipient.id,
                encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
            }],
        }));

        const stale = await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_plain",
            expectedRevision: 0,
            displayName: "Shared token",
            kind: "token",
            toMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
        }));
        expect(stale).toEqual({ ok: false, error: "resource_changed" });

        const mismatched = await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_plain",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "plain",
            storedContent: sealTestResource("resource_mode_to_plain"),
        }));
        expect(mismatched).toEqual({ ok: false, error: "invalid_resource" });

        const converted = await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_plain",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
        }));
        expect(converted).toEqual({ ok: true, value: { resourceId: "resource_mode_to_plain", revision: 2 } });

        const row = await db.savedSecretResource.findUniqueOrThrow({
            where: { id: "resource_mode_to_plain" },
            select: {
                encryptionMode: true,
                revision: true,
                accountGrants: { select: { accountId: true } },
                keyEnvelopes: { select: { recipientAccountId: true } },
            },
        });
        expect(row.encryptionMode).toBe("plain");
        expect(row.revision).toBe(2);
        expect(row.accountGrants.map((grant) => grant.accountId)).toEqual([recipient.id]);
        expect(row.keyEnvelopes).toEqual([]);

        const material = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(material[0]).toMatchObject({
            resourceId: "resource_mode_to_plain",
            entry: { materialStatus: "ready", revision: 2, encryptionMode: "plain" },
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
        });
    });

    // Plan 10.08 §10.5: a conversion is "subject to Home policy". A Home whose
    // storage policy admits only one mode refuses a conversion into the other,
    // with the same mode decision Session storage already applies.
    it("refuses a conversion into a mode the Home storage policy does not allow", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee" });
        const ownerMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_policy_keeps_e2ee",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "e2ee",
            storedContent: sealTestResource("resource_policy_keeps_e2ee"),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }],
        }));

        const refused = await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_policy_keeps_e2ee",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
        }));
        expect(refused).toEqual({ ok: false, error: "forbidden" });

        const row = await db.savedSecretResource.findUniqueOrThrow({
            where: { id: "resource_policy_keeps_e2ee" },
            select: { encryptionMode: true, revision: true, keyEnvelopes: { select: { recipientAccountId: true } } },
        });
        expect(row).toEqual({
            encryptionMode: "e2ee",
            revision: 1,
            keyEnvelopes: [{ recipientAccountId: owner.id }],
        });

        // Rename and rotation in the resource's existing mode are not a
        // conversion and stay untouched by the policy.
        expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_policy_keeps_e2ee",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            storedContent: sealTestResource("resource_policy_keeps_e2ee"),
        }))).toEqual({ ok: true, value: { resourceId: "resource_policy_keeps_e2ee", revision: 2 } });
    });

    it("converts an owned Plain resource to E2EE with the owner envelope, and refuses one without it", async () => {
        const ownerMaterial = createE2eeAccountMaterial();
        const recipientMaterial = createE2eeAccountMaterial();
        const owner = await db.account.create({ data: ownerMaterial.account, select: { id: true } });
        const recipient = await db.account.create({ data: recipientMaterial.account, select: { id: true } });
        const plainRecipient = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await db.userRelationship.createMany({
            data: [
                { fromUserId: owner.id, toUserId: recipient.id, status: "friend" },
                { fromUserId: owner.id, toUserId: plainRecipient.id, status: "friend" },
            ],
        });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_e2ee",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
            accountGrants: [recipient.id, plainRecipient.id],
        }));

        // A Plain recipient can hold no envelope, so naming one is refused
        // rather than silently dropped.
        expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_e2ee",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "e2ee",
            storedContent: sealTestResource("resource_mode_to_e2ee"),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }, {
                recipientAccountId: plainRecipient.id,
                encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
            }],
        }))).toEqual({ ok: false, error: "invalid_resource" });

        const withoutOwnerEnvelope = await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_e2ee",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "e2ee",
            storedContent: sealTestResource("resource_mode_to_e2ee"),
        }));
        expect(withoutOwnerEnvelope).toEqual({ ok: false, error: "invalid_resource" });

        const converted = await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_to_e2ee",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "e2ee",
            storedContent: sealTestResource("resource_mode_to_e2ee"),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(ownerMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: ownerMaterial.fingerprint,
            }, {
                recipientAccountId: recipient.id,
                encryptedDataKey: sealTestDataKey(recipientMaterial.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientMaterial.fingerprint,
            }],
        }));
        expect(converted).toEqual({ ok: true, value: { resourceId: "resource_mode_to_e2ee", revision: 2 } });

        const row = await db.savedSecretResource.findUniqueOrThrow({
            where: { id: "resource_mode_to_e2ee" },
            select: {
                encryptionMode: true,
                revision: true,
                accountGrants: { select: { accountId: true } },
                keyEnvelopes: { select: { recipientAccountId: true } },
            },
        });
        expect(row.encryptionMode).toBe("e2ee");
        expect(row.revision).toBe(2);
        expect(row.accountGrants.map((grant) => grant.accountId).sort())
            .toEqual([recipient.id, plainRecipient.id].sort());
        expect(row.keyEnvelopes.map((envelope) => envelope.recipientAccountId).sort())
            .toEqual([owner.id, recipient.id].sort());

        const material = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, recipient.id));
        expect(material[0]).toMatchObject({
            resourceId: "resource_mode_to_e2ee",
            entry: { materialStatus: "ready", revision: 2, encryptionMode: "e2ee" },
        });
        // The Plain recipient keeps its grant and its own Account mode, and
        // now sees the typed mode-incompatible state instead of a value.
        const plainMaterial = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, plainRecipient.id));
        expect(plainMaterial[0]).toMatchObject({
            resourceId: "resource_mode_to_e2ee",
            entry: { materialStatus: "recipient_mode_unsupported", revision: 2, encryptionMode: "e2ee" },
        });
        expect(JSON.stringify(plainMaterial)).not.toContain("secret-value");
        expect(await db.account.findUniqueOrThrow({ where: { id: plainRecipient.id }, select: { encryptionMode: true } }))
            .toEqual({ encryptionMode: "plain" });
    });

    it("refuses a conversion into E2EE for an owner whose Account holds no content key", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_plain_owner",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
        }));
        expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_plain_owner",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            toMode: "e2ee",
            storedContent: sealTestResource("resource_plain_owner"),
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(createE2eeAccountMaterial().contentPublicKey),
                recipientContentPublicKeyFingerprint: "fingerprint",
            }],
        }))).toEqual({ ok: false, error: "recipient_mode_unsupported" });
    });

    it("keeps refusing a mode/content mismatch and stray envelopes on an ordinary update", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
        await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_unchanged",
            displayName: "Shared token",
            kind: "token",
            encryptionMode: "plain",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Shared token", kind: "token", value: "secret-value" },
            },
        }));

        expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_unchanged",
            expectedRevision: 1,
            displayName: "Shared token",
            kind: "token",
            storedContent: sealTestResource("resource_mode_unchanged"),
        }))).toEqual({ ok: false, error: "invalid_resource" });

        // Envelope material only ever travels with an explicit conversion; the
        // repair owner keeps every other envelope write.
        expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId: "resource_mode_unchanged",
            expectedRevision: 1,
            displayName: "Renamed token",
            kind: "token",
            storedContent: {
                t: "plain",
                v: { v: 1, name: "Renamed token", kind: "token", value: "secret-value" },
            },
            keyEnvelopes: [{
                recipientAccountId: owner.id,
                encryptedDataKey: sealTestDataKey(createE2eeAccountMaterial().contentPublicKey),
                recipientContentPublicKeyFingerprint: "fingerprint",
            }],
        }))).toEqual({ ok: false, error: "invalid_resource" });

        const unchanged = await db.savedSecretResource.findUniqueOrThrow({
            where: { id: "resource_mode_unchanged" },
            select: { encryptionMode: true, revision: true },
        });
        expect(unchanged).toEqual({ encryptionMode: "plain", revision: 1 });
    });
});
