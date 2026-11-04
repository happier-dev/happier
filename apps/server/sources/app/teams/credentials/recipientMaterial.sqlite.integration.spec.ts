import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
    computeTeamCredentialConnectedAccountSourceVersionV1,
    computeTeamCredentialPoolMemberSourceVersionV1,
    computeTeamCredentialSourceMemberKeyV1,
    createTeamCredentialDirectMaterialStoredV1,
    materializeTeamCredentialDirectMaterialV1,
    encodeSessionTeamCredentialSlotKeyV1,
} from "@happier-dev/protocol/teams";
import {
    computeCanonicalDomainSeparatedDigest,
    signAccountContentKeyBindingV1,
    verifyAccountContentKeyBindingV1,
} from "@happier-dev/protocol";
import type { ProviderConnectionId } from "@happier-dev/protocol/providers/ids";
import tweetnacl from "tweetnacl";

const TEST_CONTRIBUTION_CONTRACT_VERSION = "artifact-example-1";
const TEST_DIRECT_CONTRIBUTION_CONTRACT_VERSION = computeCanonicalDomainSeparatedDigest(
    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
    [TEST_CONTRIBUTION_CONTRACT_VERSION],
);

function directCredentialMetadata(credentialRevision: string) {
    return {
        v: 4 as const,
        storage: "stored_envelope_v1" as const,
        credentialRevision,
        directExportContract: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
        contributionContractVersion: TEST_CONTRIBUTION_CONTRACT_VERSION,
        values: { scopes: [] },
    };
}

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
    createServiceAccountTokenIdentityFields,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import {
    prepareTeamCredentialRecipientMaterialInTx,
    readTeamCredentialDirectMaterialCensusInTx,
    readCurrentTeamCredentialRecipientMaterialInTx,
    readTeamCredentialRecipientMaterialInTx,
    upsertTeamCredentialRecipientMaterialInTx,
    withdrawTeamCredentialRecipientMaterialInTx,
} from "./recipientMaterial";
import { readTeamCredentialActivityInTx } from "./resourceActivity";
import { readTeamCredentialCatalogInTx } from './resourceRead';
import { updateTeamCredentialResourceInTx } from './resourceUpdate';

function createE2eeAccountMaterial(
    signing = tweetnacl.sign.keyPair(),
) {
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
    if (!verified) throw new Error("test content-key binding must verify");
    return {
        signing,
        contentPublicKey: content.publicKey,
        contentPublicKeySig,
        fingerprint: verified.contentPublicKeyFingerprint,
    };
}

describe("Team credential recipient material", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "team-credential-recipient-material-",
            env: {
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('withdraws only the source owner’s exact publication and preserves other members and newer replacements', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
        const other = await db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
        const team = await db.team.create({ data: { name: 'Withdrawal' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'member' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: other.id, role: 'owner' } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: owner.id, displayName: 'Withdrawal',
            disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: '{}', directSourceVersionsJson: JSON.stringify({ member: 'new', sibling: 'sibling-version' }),
        } });
        for (const [sourceMemberKey, sourceVersion] of [['member', 'new'], ['sibling', 'sibling-version']]) {
            await db.teamCredentialRecipientMaterial.create({ data: {
                resourceId: resource.id, recipientAccountId: other.id, sourceMemberKey, sourceVersion,
                recipientMode: 'plain', storedMaterial: Buffer.from('{}'),
            } });
        }
        const input = { actorAccountId: owner.id, teamId: team.id, resourceId: resource.id,
            sourceMemberKey: 'member', expectedResourceRevision: resource.revision, expectedPublishedSourceVersion: 'new' };
        await expect(inTx(tx => withdrawTeamCredentialRecipientMaterialInTx(tx, { ...input, actorAccountId: other.id })))
            .resolves.toMatchObject({ ok: false, reason: 'source_owner_required' });
        await expect(inTx(tx => withdrawTeamCredentialRecipientMaterialInTx(tx, { ...input, teamId: 'wrong-team' })))
            .resolves.toMatchObject({ ok: false, reason: 'resource_not_found' });
        await expect(inTx(tx => withdrawTeamCredentialRecipientMaterialInTx(tx, { ...input, expectedPublishedSourceVersion: 'old' })))
            .resolves.toMatchObject({ ok: false, reason: 'source_changed' });
        await expect(inTx(tx => withdrawTeamCredentialRecipientMaterialInTx(tx, { ...input, expectedResourceRevision: resource.revision + 1 })))
            .resolves.toMatchObject({ ok: false, reason: 'resource_changed' });
        expect(await db.teamCredentialRecipientMaterial.count({ where: { resourceId: resource.id } })).toBe(2);
        await expect(inTx(tx => withdrawTeamCredentialRecipientMaterialInTx(tx, input))).resolves.toMatchObject({ ok: true, changed: true });
        expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).directSourceVersionsJson)
            .toBe(JSON.stringify({ sibling: 'sibling-version' }));
        expect(await db.teamCredentialRecipientMaterial.findMany({ where: { resourceId: resource.id }, select: { sourceMemberKey: true } }))
            .toEqual([{ sourceMemberKey: 'sibling' }]);
        await expect(inTx(tx => withdrawTeamCredentialRecipientMaterialInTx(tx, input))).resolves.toMatchObject({ ok: true, changed: false });
    });

    it.each(["account", "service"] as const)("writes %s configuration through the custodian and fails closed after the final direct grant is removed", async (scope) => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Direct material team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } });
        const service = { pluginId: "example.accounts", localId: "service" };
        const sourceAccount = { service, accountId: "source" };
        const sourceCredential = await db.serviceAccountToken.create({ data: {
            accountId: custodian.id,
            ...createServiceAccountTokenIdentityFields({ ref: sourceAccount, authenticationModeId: "api-key" }),
            token: Buffer.from("source-secret"),
            metadata: directCredentialMetadata("csr_cccccccccccccccccccccc"),
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Static credential",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "team_visibility_required",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "connected_account", target: {
                kind: "account", account: sourceAccount,
            }, credentialIncarnation: sourceCredential.id }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "direct" } },
        } });
        const sourceVersion = computeTeamCredentialConnectedAccountSourceVersionV1({
            sourceAccountId: sourceAccount.accountId,
            credentialIncarnation: sourceCredential.id,
            sourceMember: {
                kind: "connected_account",
                service,
                connectedAccountId: "source",
            },
            credentialRevision: "csr_cccccccccccccccccccccc",
            configurationRevision: null,
            authenticationModeId: "api-key",
            contributionContractVersion: TEST_DIRECT_CONTRIBUTION_CONTRACT_VERSION,
            ...(scope === "service" ? { privateConfigurationFingerprint: "service-configuration-1" } : {}),
        });
        const payload = {
            v: 1 as const,
            domain: "happier.team-credential-direct-material" as const,
            homeServerIdentityId: "home",
            teamId: team.id,
            resourceId: resource.id,
            resourceRevision: resource.revision,
            recipientAccountId: recipient.id,
            sourceMember: {
                kind: "connected_account" as const,
                service,
                connectedAccountId: "source",
            },
            sourceVersion,
            material: {
                kind: "qualified_connected_account" as const,
                credential: { v: 1 as const, values: { token: "secret-value" } },
                configuration: null,
                authenticationModeId: "api-key",
            },
        };
        const stored = createTeamCredentialDirectMaterialStoredV1({ payload, recipientMode: "plain" });
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(payload.sourceMember);
        const purpose = {
            consumer: { pluginId: "example.agent", localId: "runtime" },
            purpose: "model-request",
        } as const;
        const session = await db.session.create({ data: {
            accountId: recipient.id,
            tag: `direct-material-${crypto.randomUUID()}`,
            metadata: "{}",
            encryptionMode: "plain",
            currentStorageState: "hosted",
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
            agentState: null,
            active: true,
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id,
            slotKind: "connected_service_purpose:direct",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({
                kind: "connected_service_purpose", purpose,
            })),
            resourceId: resource.id,
            resourceRevision: resource.revision,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "edit",
            canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        const readCurrent = () => inTx(tx => readCurrentTeamCredentialRecipientMaterialInTx(tx, {
            teamId: team.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            slot: { kind: "connected_service_purpose", purpose },
            disclosedMember: sourceAccount,
            consumer: { kind: "session", sessionId: session.id },
            sessionAuthentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
            authentication: { authenticationAuthority: "present_user" },
        }));
        await expect(readCurrent()).resolves.toEqual({
            ok: false,
            outcome: "unavailable",
            reason: "source_changed",
        });
        await expect(db.teamCredentialActivityEvent.count({
            where: { resourceId: resource.id, kind: "direct_delivered" },
        })).resolves.toBe(0);
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id, resourceId: resource.id, recipientAccountId: recipient.id,
            sourceMemberKey, sourceVersion, recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null, stored,
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: null,
            expectedPublishedSourceVersion: null,
        }))).resolves.toMatchObject({ ok: true });
        await expect(inTx(tx => prepareTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            sourceMemberKey,
            cursor: null,
        }))).resolves.toMatchObject({
            ok: true,
            resourceRevision: resource.revision,
            source: { kind: "connected_account" },
            recipients: [{
                recipientAccountId: recipient.id,
                recipientMode: "plain",
                recipientContentPublicKey: null,
                recipientContentPublicKeyFingerprint: null,
                expectedStoredSourceVersion: sourceVersion,
            }],
            nextCursor: null,
        });
        await expect(inTx(tx => readTeamCredentialDirectMaterialCensusInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            cursor: null,
        }))).resolves.toMatchObject({
            ok: true,
            recipients: [{ recipientAccountId: recipient.id, readiness: "ready" }],
        });
        const concurrentFirstOpens = await Promise.all([readCurrent(), readCurrent(), readCurrent()]);
        expect(concurrentFirstOpens).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
            ok: true,
            admittedResource: { displayName: resource.displayName, teamId: team.id },
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
        })));
        await expect(db.teamCredentialActivityEvent.findMany({
            where: { resourceId: resource.id, kind: "direct_delivered" },
            select: {
                teamId: true,
                resourceId: true,
                kind: true,
                actorAccountId: true,
                subjectDisplayName: true,
            },
        })).resolves.toEqual([{
            teamId: team.id,
            resourceId: resource.id,
            kind: "direct_delivered",
            actorAccountId: recipient.id,
            subjectDisplayName: resource.displayName,
        }]);

        // Removing visibility preserves the durable selection intent but denies
        // the very next material open through the current Session-use owner.
        await db.sessionTeamGrant.delete({ where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } } });
        await expect(readCurrent()).resolves.toEqual({ ok: false, outcome: "unavailable", reason: "access_removed" });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(1);
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "edit",
            canApprovePermissions: false, effectiveAt: new Date(),
        } });

        const wrongSourceMember = { ...payload.sourceMember, connectedAccountId: "another-source" };
        const wrongSourceMemberKey = computeTeamCredentialSourceMemberKeyV1(wrongSourceMember);
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey: wrongSourceMemberKey,
            sourceVersion: "source-v1",
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored: createTeamCredentialDirectMaterialStoredV1({
                recipientMode: "plain",
                payload: {
                    ...payload,
                    sourceMember: wrongSourceMember,
                },
            }),
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: null,
            expectedPublishedSourceVersion: null,
        }))).resolves.toEqual({ ok: false, reason: "source_changed" });
        await expect(inTx(tx => readTeamCredentialRecipientMaterialInTx(tx, {
            resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey,
            expectedSourceVersion: sourceVersion, recipientMode: "plain",
            expectedRecipientContentPublicKeyFingerprint: null,
        }))).resolves.toMatchObject({ ok: true, stored });
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: recipient.id, resourceId: resource.id, recipientAccountId: recipient.id,
            sourceMemberKey: `${sourceMemberKey}-2`, sourceVersion, recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null, stored,
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: null,
            expectedPublishedSourceVersion: null,
        }))).resolves.toEqual({ ok: false, reason: "source_owner_required" });
        if (scope === 'account') {
            await db.serviceAccountToken.update({
                where: { id: sourceCredential.id },
                data: { metadata: directCredentialMetadata("csr_dddddddddddddddddddddd") },
            });
            await expect(readCurrent()).resolves.toEqual({
                ok: false, outcome: "unavailable", reason: "source_changed",
            });
        }
        const rotatedSourceVersion = computeTeamCredentialConnectedAccountSourceVersionV1({
            sourceAccountId: sourceAccount.accountId,
            credentialIncarnation: sourceCredential.id,
            sourceMember: payload.sourceMember,
            credentialRevision: scope === 'service' ? "csr_cccccccccccccccccccccc" : "csr_dddddddddddddddddddddd",
            configurationRevision: null,
            authenticationModeId: "api-key",
            contributionContractVersion: TEST_DIRECT_CONTRIBUTION_CONTRACT_VERSION,
            ...(scope === "service" ? { privateConfigurationFingerprint: "service-configuration-2" } : {}),
        });
        const rotatedStored = createTeamCredentialDirectMaterialStoredV1({
            recipientMode: "plain",
            payload: { ...payload, sourceVersion: rotatedSourceVersion },
        });
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion: rotatedSourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored: rotatedStored,
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: sourceVersion,
            expectedPublishedSourceVersion: sourceVersion,
        }))).resolves.toMatchObject({ ok: true, sourceVersion: rotatedSourceVersion });
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored,
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: sourceVersion,
            expectedPublishedSourceVersion: sourceVersion,
        }))).resolves.toEqual({ ok: false, reason: "source_changed" });
        await expect(readCurrent()).resolves.toMatchObject({ ok: true, sourceVersion: rotatedSourceVersion });
        const readCatalog = () => inTx(tx => readTeamCredentialCatalogInTx(tx, {
            teamId: team.id, actorAccountId: recipient.id,
            authentication: { authenticationAuthority: 'present_user' },
        }));
        await expect(readCatalog()).resolves.toMatchObject({
            ok: true, page: { resources: [expect.objectContaining({ id: resource.id, directMaterialState: 'current' })] },
        });
        // Even with an unchanged Home basis, callers cannot fetch the obsolete
        // private snapshot by supplying its old full version, including a row
        // not yet replaced after another recipient advances publication.
        await db.teamCredentialRecipientMaterial.updateMany({
            where: { resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey },
            data: { sourceVersion, storedMaterial: Buffer.from(JSON.stringify(stored)) },
        });
        await expect(inTx(tx => readTeamCredentialRecipientMaterialInTx(tx, {
            resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey,
            expectedSourceVersion: sourceVersion, recipientMode: 'plain',
            expectedRecipientContentPublicKeyFingerprint: null,
        }))).resolves.toMatchObject({ ok: false, reason: 'source_changed' });
        await expect(readCatalog()).resolves.toMatchObject({
            ok: true, page: { resources: [expect.objectContaining({ id: resource.id, directMaterialState: 'stale' })] },
        });
        await db.teamCredentialRecipientMaterial.updateMany({
            where: { resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey },
            data: { sourceVersion: rotatedSourceVersion, storedMaterial: Buffer.from(JSON.stringify(rotatedStored)) },
        });

        await expect(inTx(tx => readTeamCredentialDirectMaterialCensusInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            cursor: null,
        }))).resolves.toMatchObject({
            ok: true,
            recipients: [{ recipientAccountId: recipient.id, readiness: "ready" }],
        });

        const overlappingGroup = await db.teamGroup.create({ data: {
            teamId: team.id, name: 'Direct recipients', nameKey: 'direct-recipients',
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: overlappingGroup.id, teamMembershipId: membership.id,
        } });
        await db.teamCredentialGroupGrant.create({ data: {
            resourceId: resource.id, teamGroupId: overlappingGroup.id, deliveryMode: 'direct',
        } });
        const replacement = await inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id, authentication: { authenticationAuthority: 'present_user' },
            patch: { resourceId: resource.id, expectedRevision: resource.revision, replacement: {
                enabled: true, displayName: resource.displayName, sessionUsePolicy: 'team_visibility_required',
                requestPolicy: null, allMembersAllowedRoutes: null, groupGrants: [],
                memberGrants: [{ teamMembershipId: membership.id, allowedRoutes: ['direct'] }],
                usageLimitDelta: { upserts: [], deleteIds: [] },
            } },
        }));
        expect(replacement).toMatchObject({ ok: true, revision: resource.revision + 1 });
        const retained = await inTx(tx => readTeamCredentialRecipientMaterialInTx(tx, {
            resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey,
            expectedSourceVersion: rotatedSourceVersion, recipientMode: 'plain',
            expectedRecipientContentPublicKeyFingerprint: null,
        }));
        expect(retained).toMatchObject({ ok: true });
        if (!retained.ok) throw new Error('Expected retained recipient material');
        expect(materializeTeamCredentialDirectMaterialV1({
            stored: retained.stored, recipientMode: 'plain', expected: {
                homeServerIdentityId: 'home', teamId: team.id, resourceId: resource.id,
                resourceRevision: resource.revision + 1, recipientAccountId: recipient.id,
                sourceMemberKey, sourceVersion: rotatedSourceVersion,
            },
        })).toMatchObject({ sourceVersion: rotatedSourceVersion, material: payload.material });

        // Census readiness is bound to the recipient's current Account mode
        // and content key, just like the fetch path. A mode transition makes
        // the old Plain tuple stale until the source owner republishes it.
        const e2eeMaterial = createE2eeAccountMaterial();
        await db.account.update({
            where: { id: recipient.id },
            data: {
                encryptionMode: "e2ee",
                publicKey: Buffer.from(e2eeMaterial.signing.publicKey).toString("hex"),
                contentPublicKey: Buffer.from(e2eeMaterial.contentPublicKey),
                contentPublicKeySig: Buffer.from(e2eeMaterial.contentPublicKeySig),
            },
        });
        await expect(inTx(tx => readTeamCredentialDirectMaterialCensusInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            cursor: null,
        }))).resolves.toMatchObject({
            ok: true,
            recipients: [{ recipientAccountId: recipient.id, readiness: "preparing" }],
        });

        const encryptedStored = createTeamCredentialDirectMaterialStoredV1({
            payload: { ...payload, sourceVersion: rotatedSourceVersion },
            recipientMode: "e2ee",
            recipientContentPublicKey: e2eeMaterial.contentPublicKey,
            randomBytes: length => new Uint8Array(length).fill(17),
        });
        await db.teamCredentialRecipientMaterial.update({
            where: {
                resourceId_recipientAccountId_sourceMemberKey: {
                    resourceId: resource.id,
                    recipientAccountId: recipient.id,
                    sourceMemberKey,
                },
            },
            data: {
                recipientMode: "e2ee",
                recipientContentPublicKeyFingerprint: e2eeMaterial.fingerprint,
                storedMaterial: Buffer.from(JSON.stringify(encryptedStored)),
            },
        });
        await expect(inTx(tx => readTeamCredentialDirectMaterialCensusInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            cursor: null,
        }))).resolves.toMatchObject({
            ok: true,
            recipients: [{ recipientAccountId: recipient.id, readiness: "ready" }],
        });

        // Rotating only the content key under the same Account signing key
        // must also invalidate the old tuple in the reconstructible census.
        const rotatedE2eeMaterial = createE2eeAccountMaterial(e2eeMaterial.signing);
        await db.account.update({
            where: { id: recipient.id },
            data: {
                contentPublicKey: Buffer.from(rotatedE2eeMaterial.contentPublicKey),
                contentPublicKeySig: Buffer.from(rotatedE2eeMaterial.contentPublicKeySig),
            },
        });
        await expect(inTx(tx => readTeamCredentialDirectMaterialCensusInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            cursor: null,
        }))).resolves.toMatchObject({
            ok: true,
            recipients: [{ recipientAccountId: recipient.id, readiness: "preparing" }],
        });

        // E2EE/plain mode authority: a plain envelope never satisfies an E2EE
        // recipient binding, and a stale recipient fingerprint fails closed.
        await expect(inTx(tx => readTeamCredentialRecipientMaterialInTx(tx, {
            resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey,
            expectedSourceVersion: rotatedSourceVersion, recipientMode: "e2ee",
            expectedRecipientContentPublicKeyFingerprint: "deadbeef",
        }))).resolves.toEqual({ ok: false, reason: "recipient_mode_mismatch" });

        await db.teamCredentialMemberGrant.delete({ where: {
            resourceId_teamMembershipId: { resourceId: resource.id, teamMembershipId: membership.id },
        } });
        await expect(inTx(tx => readTeamCredentialRecipientMaterialInTx(tx, {
            resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey,
            expectedSourceVersion: rotatedSourceVersion,
            recipientMode: "plain",
            expectedRecipientContentPublicKeyFingerprint: null,
        }))).resolves.toEqual({ ok: false, reason: "access_removed" });

        await db.teamCredentialResource.delete({ where: { id: resource.id } });
        await expect(inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId: resource.id,
            actorAccountId: custodian.id,
            authentication: { authenticationAuthority: "present_user" },
        }))).resolves.toMatchObject({
            ok: true,
            page: {
                items: expect.arrayContaining([expect.objectContaining({
                    kind: "direct_delivered",
                    actorDisplayName: null,
                    subjectDisplayName: resource.displayName,
                })]),
                nextCursor: null,
            },
        });
    });

    it("does not let an older preparation overwrite a newer material tuple", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Direct material CAS team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Static credential",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection", connectionSecurityFingerprint: `connection-security:v1:${"a".repeat(43)}`, credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "direct" } },
        } });
        const sourceMember = { kind: "provider_credential_slot" as const, connectionId: "connection" as ProviderConnectionId, credentialSlotId: "apiKey" };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        const sourceVersion = "provider-source-v1";
        const storedFor = (sourceVersion: string, value: string) => createTeamCredentialDirectMaterialStoredV1({
            recipientMode: "plain",
            payload: {
                v: 1,
                domain: "happier.team-credential-direct-material",
                homeServerIdentityId: "home",
                teamId: team.id,
                resourceId: resource.id,
                resourceRevision: resource.revision,
                recipientAccountId: recipient.id,
                sourceMember,
                sourceVersion,
                material: {
                    kind: "provider_api_key", value,
                    runtimeBinding: {
                        provider: { identity: { pluginId: "happier.provider.test", localId: "test" }, definitionRevision: 1 },
                        endpoint: {
                            endpointTemplateId: "responses", normalizedUrl: "https://api.example.test/v1",
                            protocol: "openai-responses", publicHeaders: {},
                        },
                        credentialTransport: {
                            id: "api-key", protocols: ["openai-responses"], uses: ["runtime"],
                            destination: { kind: "httpHeader", name: "Authorization", format: "bearer" },
                        },
                    },
                },
            },
        });

        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored: storedFor(sourceVersion, "first"),
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: null,
            expectedPublishedSourceVersion: null,
        }))).resolves.toMatchObject({ ok: true });
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored: storedFor(sourceVersion, "newer"),
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: sourceVersion,
            expectedPublishedSourceVersion: sourceVersion,
        }))).resolves.toMatchObject({ ok: true, sourceVersion });

        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion: "source-old",
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored: storedFor("source-old", "stale"),
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: "stale-observation",
            expectedPublishedSourceVersion: null,
        }))).resolves.toEqual({ ok: false, reason: "source_changed" });
        await expect(db.teamCredentialRecipientMaterial.findUniqueOrThrow({
            where: { resourceId_recipientAccountId_sourceMemberKey: { resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey } },
            select: { sourceVersion: true },
        })).resolves.toEqual({ sourceVersion });

        // A rejection decided after the publication precondition must leave the
        // published version alone: advancing it would strand every recipient
        // whose still-valid row carries the previous one.
        const publishedBefore = await db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resource.id },
            select: { directSourceVersionsJson: true },
        });
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion: "source-old",
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored: storedFor("source-old", "stale"),
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: "stale-observation",
            expectedPublishedSourceVersion: sourceVersion,
        }))).resolves.toEqual({ ok: false, reason: "source_changed" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resource.id },
            select: { directSourceVersionsJson: true },
        })).resolves.toEqual(publishedBefore);
        await expect(db.teamCredentialRecipientMaterial.findUniqueOrThrow({
            where: { resourceId_recipientAccountId_sourceMemberKey: { resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey } },
            select: { sourceVersion: true },
        })).resolves.toEqual({ sourceVersion });

        // A recipient key that no longer matches is the same shape and must be
        // just as inert.
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion: "provider-source-v2",
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: "content-key:v1:unexpected",
            stored: storedFor("provider-source-v2", "rotated"),
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: sourceVersion,
            expectedPublishedSourceVersion: sourceVersion,
        }))).resolves.toEqual({ ok: false, reason: "invalid_material" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resource.id },
            select: { directSourceVersionsJson: true },
        })).resolves.toEqual(publishedBefore);

        // The same rotation with every precondition satisfied still commits
        // publication and the accepted tuple together.
        await expect(inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion: "provider-source-v2",
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored: storedFor("provider-source-v2", "rotated"),
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: sourceVersion,
            expectedPublishedSourceVersion: sourceVersion,
        }))).resolves.toMatchObject({ ok: true, sourceVersion: "provider-source-v2" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resource.id },
            select: { directSourceVersionsJson: true },
        })).resolves.toEqual({
            directSourceVersionsJson: JSON.stringify({ [sourceMemberKey]: "provider-source-v2" }),
        });
        await expect(db.teamCredentialRecipientMaterial.findUniqueOrThrow({
            where: { resourceId_recipientAccountId_sourceMemberKey: { resourceId: resource.id, recipientAccountId: recipient.id, sourceMemberKey } },
            select: { sourceVersion: true },
        })).resolves.toEqual({ sourceVersion: "provider-source-v2" });
    });

    it("accepts only a currently enabled member of the pinned Connected Service Pool", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Direct Pool team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const recipientMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const service = { pluginId: "example.connected-accounts", localId: "service" };
        const accountRef = { service, accountId: "pool-member" };
        const credential = await db.serviceAccountToken.create({
            data: {
                accountId: custodian.id,
                ...createServiceAccountTokenIdentityFields({ ref: accountRef, authenticationModeId: "api-key" }),
                token: Buffer.from("pool-secret"),
                metadata: directCredentialMetadata("csr_eeeeeeeeeeeeeeeeeeeeee"),
            },
        });
        const groupId = "shared-pool";
        const pool = await db.connectedServiceAuthGroup.create({
            data: {
                accountId: custodian.id,
                servicePluginId: service.pluginId,
                serviceLocalId: service.localId,
                qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
                qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
                groupId,
                policyJson: "{}",
            },
        });
        await db.connectedServiceAuthGroupMember.create({ data: {
            groupDbId: pool.id,
            accountId: custodian.id,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(accountRef),
            credentialId: credential.id,
            priority: 0,
            enabled: true,
        } });
        const resource = await db.teamCredentialResource.create({
            data: {
                teamId: team.id,
                custodianAccountId: custodian.id,
                displayName: "Shared Pool",
                disclosureCeiling: "direct_allowed",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1,
                    kind: "connected_pool",
                    target: { kind: "group", service, groupId },
                    poolIncarnation: pool.id,
                }),
                memberGrants: {
                    create: { teamMembershipId: recipientMembership.id, deliveryMode: "direct" },
                },
            },
        });
        const sourceMember = {
            kind: "connected_account" as const,
            service,
            connectedAccountId: accountRef.accountId,
        };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        const connectedAccountSourceVersion = computeTeamCredentialConnectedAccountSourceVersionV1({
            sourceAccountId: accountRef.accountId,
            credentialIncarnation: credential.id,
            sourceMember,
            credentialRevision: "csr_eeeeeeeeeeeeeeeeeeeeee",
            configurationRevision: null,
            authenticationModeId: "api-key",
            contributionContractVersion: TEST_DIRECT_CONTRIBUTION_CONTRACT_VERSION,
            privateConfigurationFingerprint: 'pool-service-configuration',
        });
        const poolSourceVersion = computeTeamCredentialPoolMemberSourceVersionV1({
            connectedAccountSourceVersion,
            poolIncarnation: pool.id,
            memberEnabled: true,
        });
        const stored = createTeamCredentialDirectMaterialStoredV1({
            recipientMode: "plain",
            payload: {
                v: 1,
                domain: "happier.team-credential-direct-material",
                homeServerIdentityId: "home",
                teamId: team.id,
                resourceId: resource.id,
                resourceRevision: resource.revision,
                recipientAccountId: recipient.id,
                sourceMember,
                sourceVersion: poolSourceVersion,
                material: {
                    kind: "qualified_connected_account",
                    credential: { v: 1, values: { token: "pool-secret" } },
                    configuration: null,
                    authenticationModeId: "api-key",
                },
            },
        });
        const upsert = () => inTx((tx) => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion: poolSourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored,
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: null,
            expectedPublishedSourceVersion: null,
        }));

        await expect(upsert()).resolves.toMatchObject({ ok: true });
        await expect(inTx((tx) => readTeamCredentialDirectMaterialCensusInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            cursor: null,
        }))).resolves.toMatchObject({
            ok: true,
            recipients: [{ recipientAccountId: recipient.id, readiness: "ready" }],
        });
        await db.connectedServiceAuthGroupMember.updateMany({
            where: { groupDbId: pool.id, credentialId: credential.id },
            data: { enabled: false },
        });
        await expect(inTx((tx) => readTeamCredentialRecipientMaterialInTx(tx, {
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            expectedSourceVersion: poolSourceVersion,
            recipientMode: "plain",
            expectedRecipientContentPublicKeyFingerprint: null,
        }))).resolves.toEqual({ ok: false, reason: "source_changed" });
        await expect(inTx((tx) => readTeamCredentialDirectMaterialCensusInTx(tx, {
            actorAccountId: custodian.id,
            teamId: team.id,
            resourceId: resource.id,
            cursor: null,
        }))).resolves.toMatchObject({ ok: true, recipients: [{ readiness: "preparing" }] });
    });
});
