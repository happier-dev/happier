import { describe, expect, it } from "vitest";

import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
} from "./identity";
import { toQualifiedConnectedAccountGroup } from "./groupRepository";

const service = {
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
} as const;
const groupRef = { service, groupId: "fallback" } as const;
const accountRef = {
    service,
    accountId: "provider/account",
} as const;

function row() {
    const now = new Date(1);
    return {
        id: "group-row",
        accountId: "owner",
        servicePluginId: service.pluginId,
        serviceLocalId: service.localId,
        qualifiedServiceDigest:
            createQualifiedConnectedAccountServiceDigest(service),
        qualifiedGroupDigest:
            createQualifiedConnectedAccountGroupDigest(groupRef),
        groupId: groupRef.groupId,
        displayName: null,
        policyJson: "{}",
        activeProfileId: accountRef.accountId,
        activeConnectedAccountId: accountRef.accountId,
        generation: 1,
        runtimeStateRevision: 2,
        stateJson: "{}",
        createdAt: now,
        updatedAt: now,
        members: [{
            accountId: "owner",
            qualifiedServiceDigest:
                createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest:
                createQualifiedConnectedAccountGroupDigest(groupRef),
            qualifiedIdentityDigest:
                createQualifiedConnectedAccountIdentityDigest(accountRef),
            priority: 1,
            enabled: true,
            stateJson: "{}",
            createdAt: now,
            updatedAt: now,
            credential: {
                accountId: "owner",
                servicePluginId: service.pluginId,
                serviceLocalId: service.localId,
                qualifiedServiceDigest:
                    createQualifiedConnectedAccountServiceDigest(service),
                connectedAccountId: accountRef.accountId,
                qualifiedIdentityDigest:
                    createQualifiedConnectedAccountIdentityDigest(accountRef),
            },
        }],
    };
}

describe("qualified Connected Account group repository", () => {
    it("projects one strict structured service identity", () => {
        expect(toQualifiedConnectedAccountGroup(row())).toMatchObject({
            ref: groupRef,
            activeConnectedAccountId: accountRef.accountId,
            members: [{
                connectedAccountId: accountRef.accountId,
            }],
        });
    });

    it("rejects a member linked across services even if local ids match", () => {
        const divergentService = {
            pluginId: "other.connected-accounts",
            localId: service.localId,
        };
        const divergent = row();
        divergent.members[0]!.qualifiedServiceDigest =
            createQualifiedConnectedAccountServiceDigest(divergentService);
        expect(() => toQualifiedConnectedAccountGroup(divergent))
            .toThrow(/member.*service/i);
    });

    it("rejects a disabled active member consistently with the V3 group owner", () => {
        const disabledActive = row();
        disabledActive.members[0]!.enabled = false;

        expect(() => toQualifiedConnectedAccountGroup(disabledActive))
            .toThrow(/active account.*enabled member/i);
    });
});
