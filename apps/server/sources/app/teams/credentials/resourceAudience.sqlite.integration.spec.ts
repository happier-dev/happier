import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setTeamCredentialAudienceInTx, type TeamCredentialAudienceInput } from "./resourceAudience";
import { updateTeamCredentialResourceInTx } from "./resourceUpdate";

const TEST_AUTHENTICATION = { authenticationAuthority: "present_user", authenticationEvidence: [] } as const;

describe("Team credential audience mutation", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-resource-audience-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const manager = await db.account.create({ data: { encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Credential administration" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        const managerMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "admin" } });
        const recipientMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "guest" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Developers", nameKey: "developers" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Shared connection",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "pc_source", connectionSecurityFingerprint: "connection-security:v1:source", credentialSlotId: "apiKey" }),
        } });
        const input: TeamCredentialAudienceInput = {
            resourceId: resource.id, expectedRevision: resource.revision, allMembersAllowedRoutes: null,
            groupGrants: [{ teamGroupId: group.id, allowedRoutes: ["direct"] }],
            memberGrants: [{ teamMembershipId: recipientMembership.id, allowedRoutes: ["direct"] }],
        };
        const set = (actorAccountId: string, next = input) => inTx(tx => setTeamCredentialAudienceInTx(tx, { actorAccountId, input: next, authentication: TEST_AUTHENTICATION }));
        return { custodian, manager, team, group, resource, managerMembership, recipientMembership, input, set };
    }

    it("commits one whole audience revision and refuses stale or non-manager writes", async () => {
        const f = await fixture();
        await expect(f.set(f.manager.id)).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 1 });
        // The source custodian is allowed to narrow its own audience, so this
        // replay reaches the shared CAS boundary and reports the stale revision.
        await expect(f.set(f.custodian.id)).resolves.toEqual({ ok: false, error: "resource_changed" });
        await expect(f.set(f.manager.id, { ...f.input, allMembersAllowedRoutes: ["direct"], groupGrants: [], memberGrants: [] }))
            .resolves.toEqual({ ok: false, error: "resource_changed" });
        const stored = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id }, include: { groupGrants: true, memberGrants: true } });
        expect(stored).toMatchObject({ revision: 1, allMembersDeliveryMode: null });
        expect(stored.groupGrants).toMatchObject([{ teamGroupId: f.group.id, deliveryMode: JSON.stringify(["direct"]) }]);
        expect(stored.memberGrants).toMatchObject([{ teamMembershipId: f.recipientMembership.id, deliveryMode: JSON.stringify(["direct"]) }]);
        const events = await db.teamCredentialActivityEvent.findMany({ where: { resourceId: f.resource.id } });
        expect(events).toMatchObject([{
            teamId: f.team.id, actorAccountId: f.manager.id,
            kind: "audience_changed", subjectDisplayName: f.resource.displayName,
        }]);
        const rollback = new Error("abort the composed resource mutation");
        await expect(inTx(async tx => {
            const changed = await setTeamCredentialAudienceInTx(tx, {
                actorAccountId: f.manager.id,
                input: { ...f.input, expectedRevision: 1, groupGrants: [], memberGrants: [] },
                authentication: TEST_AUTHENTICATION,
            });
            expect(changed.ok).toBe(true);
            throw rollback;
        })).rejects.toBe(rollback);
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toMatchObject({ revision: 1 });
        expect(await db.teamCredentialActivityEvent.count({ where: { resourceId: f.resource.id } })).toBe(1);
        expect(await db.teamCredentialMemberGrant.count({ where: { resourceId: f.resource.id } })).toBe(1);
        await db.teamMembership.update({ where: { id: f.managerMembership.id }, data: { status: "suspended" } });
        await expect(f.set(f.manager.id, { ...f.input, expectedRevision: 1 })).resolves.toEqual({ ok: false, error: "resource_forbidden" });
    });

    it("lets a departed source custodian only reduce the current audience while a manager may widen it", async () => {
        const f = await fixture();
        await expect(f.set(f.manager.id)).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 1 });
        await db.teamMembership.deleteMany({ where: { teamId: f.team.id, accountId: f.custodian.id } });

        await expect(f.set(f.custodian.id, {
            ...f.input,
            expectedRevision: 1,
            memberGrants: [],
        })).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 2 });
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } }))
            .toMatchObject({ revision: 2, allMembersDeliveryMode: null });
        expect(await db.teamCredentialGroupGrant.count({ where: { resourceId: f.resource.id } })).toBe(1);
        expect(await db.teamCredentialMemberGrant.count({ where: { resourceId: f.resource.id } })).toBe(0);

        await expect(f.set(f.custodian.id, {
            ...f.input,
            expectedRevision: 2,
            allMembersAllowedRoutes: ["direct"],
            memberGrants: [],
        })).resolves.toEqual({ ok: false, error: "resource_forbidden" });
        await expect(f.set(f.manager.id, {
            ...f.input,
            expectedRevision: 2,
            allMembersAllowedRoutes: ["direct"],
            memberGrants: [],
        })).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 3 });
    });

    it.each(["audience", "resource replacement"] as const)("ends prepared material only for recipients no longer entitled through %s", async (mutation) => {
        const f = await fixture();
        const setAudience = (input: TeamCredentialAudienceInput) => mutation === "audience"
            ? f.set(f.manager.id, input)
            : inTx(tx => updateTeamCredentialResourceInTx(tx, {
                actorAccountId: f.manager.id,
                authentication: TEST_AUTHENTICATION,
                patch: {
                    resourceId: input.resourceId,
                    expectedRevision: input.expectedRevision,
                    replacement: {
                        enabled: true,
                        displayName: f.resource.displayName,
                        sessionUsePolicy: "personal_allowed",
                        requestPolicy: null,
                        allMembersAllowedRoutes: input.allMembersAllowedRoutes,
                        groupGrants: [...input.groupGrants],
                        memberGrants: [...input.memberGrants],
                        usageLimitDelta: { upserts: [], deleteIds: [] },
                    },
                },
            }));
        // A second recipient holds two overlapping direct grants: the Group
        // grant and their own member grant.
        const overlapping = await db.account.create({ data: { encryptionMode: "plain" } });
        const overlappingMembership = await db.teamMembership.create({
            data: { teamId: f.team.id, accountId: overlapping.id, role: "member" },
        });
        await db.teamGroupMembership.create({ data: {
            teamId: f.team.id, teamGroupId: f.group.id, teamMembershipId: overlappingMembership.id,
        } });
        const withOverlap = {
            ...f.input,
            memberGrants: [
                ...f.input.memberGrants,
                { teamMembershipId: overlappingMembership.id, allowedRoutes: ["direct" as const] },
            ],
        };
        await expect(f.set(f.manager.id, withOverlap)).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 1 });
        const published = JSON.stringify({ "member-1": "source-version-1" });
        await db.teamCredentialResource.update({
            where: { id: f.resource.id },
            data: { directSourceVersionsJson: published },
        });
        for (const recipientAccountId of [f.recipientMembership.accountId, overlapping.id]) {
            await db.teamCredentialRecipientMaterial.create({ data: {
                resourceId: f.resource.id,
                recipientAccountId,
                sourceMemberKey: "member-1",
                sourceVersion: "source-version-1",
                recipientMode: "plain",
                storedMaterial: new Uint8Array([1, 2, 3]),
            } });
        }

        // Replacing the audience ends exactly the material of the recipients it
        // no longer entitles. A recipient who keeps another effective direct
        // grant keeps their prepared row, and the source has not changed, so the
        // published source versions are untouched
        // (06-direct-credential-delivery.md:572, :579).
        await expect(setAudience({
            ...withOverlap,
            expectedRevision: 1,
            memberGrants: [{ teamMembershipId: overlappingMembership.id, allowedRoutes: ["direct"] }],
        })).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 2 });
        expect(await db.teamCredentialRecipientMaterial.findMany({
            where: { resourceId: f.resource.id }, select: { recipientAccountId: true },
        })).toEqual([{ recipientAccountId: overlapping.id }]);
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } }))
            .toMatchObject({ directSourceVersionsJson: published });

        // Removing the last effective direct grant ends that recipient's row too.
        await expect(setAudience({
            ...withOverlap, expectedRevision: 2, groupGrants: [], memberGrants: [],
        })).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 3 });
        expect(await db.teamCredentialRecipientMaterial.count({ where: { resourceId: f.resource.id } })).toBe(0);
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } }))
            .toMatchObject({ directSourceVersionsJson: published });
    });

    it("saves a broker audience on a compatible offline persistent custodian Machine", async () => {
        const f = await fixture();
        const machine = await db.machine.create({ data: {
            id: `broker-${f.custodian.id}`,
            accountId: f.custodian.id,
            metadata: "{}",
            kind: "persistent",
            active: false,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: { brokerMachineId: machine.id } });

        await expect(f.set(f.manager.id, {
            ...f.input, allMembersAllowedRoutes: ["brokered"], groupGrants: [], memberGrants: [],
        })).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 1 });
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } }))
            .toMatchObject({ brokerMachineId: machine.id, allMembersDeliveryMode: JSON.stringify(["brokered"]), revision: 1 });
    });

    it.each([null, "brokered"] as const)("normalized resource update preserves dormant legacy consent with %s audience", async (deliveryMode) => {
        const f = await fixture();
        const broker = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.custodian.id,
            metadata: "{}", kind: "persistent", active: false,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: {
            enabled: false, allMembersDeliveryMode: deliveryMode, brokerMachineId: broker.id,
        } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 0, enabled: true },
        }))).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 1 });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 1,
                replacement: { allMembersAllowedRoutes: ["direct"] } },
        }))).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 2 });
        const stored = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } });
        expect(JSON.parse(stored.disclosureCeiling)).toEqual({ policy: { preferredAllowedModes: ["brokered", "direct"] } });
        expect(JSON.parse(stored.allMembersDeliveryMode!)).toEqual(["direct"]);
    });

    it("normalized resource update reserves delivery consent for the custodian", async () => {
        const f = await fixture();
        for (const replacement of [false, true]) {
            const deliveryPolicy = { preferredAllowedModes: ["vendor-native" as const] };
            await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.manager.id,
                authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 0,
                    ...(replacement ? { replacement: { custodian: {
                        source: JSON.parse(f.resource.sourceBindingJson), deliveryPolicy,
                        brokerPlacement: null,
                    } } } : { deliveryPolicy }),
                },
            }))).resolves.toEqual({ ok: false, error: "resource_forbidden" });
        }
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } }))
            .toMatchObject({ revision: 0, disclosureCeiling: "direct_allowed" });
    });

    it("normalized resource update narrows departed custodian grants without minting broker authority", async () => {
        const f = await fixture();
        const retiredBroker = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.custodian.id,
            metadata: "{}", kind: "persistent", active: false } });
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: {
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["direct", "vendor-native"] },
                experimentalBindingConfirmations: [] }),
            allMembersDeliveryMode: JSON.stringify(["direct", "vendor-native"]),
            brokerMachineId: retiredBroker.id,
        } });
        await db.teamCredentialMemberGrant.create({ data: { resourceId: f.resource.id,
            teamMembershipId: f.recipientMembership.id, deliveryMode: JSON.stringify(["direct"]) } });
        await db.teamCredentialGroupGrant.create({ data: { resourceId: f.resource.id,
            teamGroupId: f.group.id, deliveryMode: JSON.stringify(["vendor-native"]) } });
        await db.teamMembership.deleteMany({ where: { teamId: f.team.id, accountId: f.custodian.id } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
            authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 0,
                deliveryPolicy: { preferredAllowedModes: ["vendor-native"] } },
        }))).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 1 });
        const stored = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id },
            include: { memberGrants: true, groupGrants: true } });
        expect(JSON.parse(stored.allMembersDeliveryMode!)).toEqual(["vendor-native"]);
        expect(stored.memberGrants).toEqual([]);
        expect(stored.groupGrants.map(grant => JSON.parse(grant.deliveryMode))).toEqual([["vendor-native"]]);
        expect(JSON.parse(stored.disclosureCeiling)).toEqual({ policy: { preferredAllowedModes: ["vendor-native"] } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
            authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 1, enabled: false },
        }))).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 2 });
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } }))
            .toMatchObject({ enabled: false, brokerMachineId: retiredBroker.id });
    });

    it("normalized resource update keeps confirmation and audience authority separate from custodian preference", async () => {
        const f = await fixture();
        const confirmations = [{ v: 1, connectionId: "pc_source", agentTargetKey: "codex", modelId: "gpt-5",
            compatibilityFingerprint: "compatibility-source-1", confirmedAt: 1 }];
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: {
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ["direct"] },
                experimentalBindingConfirmations: confirmations }),
        } });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
            authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 0,
                replacement: { custodian: { source: JSON.parse(f.resource.sourceBindingJson),
                    deliveryPolicy: { preferredAllowedModes: ["vendor-native", "direct"] }, brokerPlacement: null } } },
        }))).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 1 });
        const allowed = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } });
        expect(JSON.parse(allowed.disclosureCeiling)).toEqual({ policy: { preferredAllowedModes: ["vendor-native", "direct"] } });
        expect(allowed.allMembersDeliveryMode).toBeNull();
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.manager.id,
            authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 1,
                replacement: { allMembersAllowedRoutes: ["vendor-native"] } },
        }))).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 2 });
        await expect(inTx(tx => updateTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
            authentication: TEST_AUTHENTICATION, patch: { resourceId: f.resource.id, expectedRevision: 2,
                deliveryPolicy: { preferredAllowedModes: ["direct", "vendor-native"] } },
        }))).resolves.toEqual({ ok: true, resourceId: f.resource.id, revision: 3 });
        const reordered = await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } });
        expect(JSON.parse(reordered.disclosureCeiling)).toEqual({ policy: { preferredAllowedModes: ["direct", "vendor-native"] } });
        expect(JSON.parse(reordered.allMembersDeliveryMode!)).toEqual(["vendor-native"]);
    });

    it("rejects foreign audiences and source-ceiling escalation without changing prior grants", async () => {
        const f = await fixture();
        const other = await db.team.create({ data: { name: "Other Team" } });
        const foreign = await db.teamGroup.create({ data: { teamId: other.id, name: "Foreign", nameKey: "foreign" } });
        await expect(f.set(f.manager.id, { ...f.input, groupGrants: [{ teamGroupId: foreign.id, allowedRoutes: ["direct"] }] }))
            .resolves.toEqual({ ok: false, error: "invalid_audience" });
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: { disclosureCeiling: "brokered_only" } });
        await expect(f.set(f.manager.id)).resolves.toEqual({ ok: false, error: "disclosure_not_allowed" });
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: f.resource.id } })).toMatchObject({ revision: 0 });
        expect(await db.teamCredentialGroupGrant.count({ where: { resourceId: f.resource.id } })).toBe(0);
        expect(await db.teamCredentialMemberGrant.count({ where: { resourceId: f.resource.id } })).toBe(0);
    });
});
