import { describe, expect, it, vi } from "vitest";

import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
} from "./identity";
import {
    createQualifiedConnectedAccountGroup,
    encodeQualifiedGroupStateForActiveAccount,
    listAllQualifiedConnectedAccountGroupsInTx,
    toQualifiedConnectedAccountGroup,
} from "./groupRepository";

const service = {
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
} as const;
const groupRef = { service, groupId: "fallback" } as const;
const accountRef = {
    service,
    accountId: "provider/account",
} as const;

function row(groupId: string = groupRef.groupId) {
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
        groupId,
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

type GroupListStorage =
    Parameters<typeof listAllQualifiedConnectedAccountGroupsInTx>[0];

/**
 * Stands in for the Prisma group delegate — a genuine storage boundary — and
 * honours `take` exactly as the database would, so a reader that keeps a page
 * window silently truncates here instead of appearing complete.
 */
function storageHolding(groupCount: number): GroupListStorage {
    const rows = Array.from({ length: groupCount }, (_, index) => {
        const groupId = `fallback-${index}`;
        const retained = row(groupId);
        const digest = createQualifiedConnectedAccountGroupDigest({
            service,
            groupId,
        });
        retained.id = `group-row-${index}`;
        retained.qualifiedGroupDigest = digest;
        retained.members[0]!.qualifiedGroupDigest = digest;
        return retained;
    });
    return {
        connectedServiceAuthGroup: {
            findMany: async (args: Readonly<{ take?: number }>) => (
                typeof args.take === "number"
                    ? rows.slice(0, args.take)
                    : rows
            ),
        },
    } as unknown as GroupListStorage;
}

const { uniqueConflictTransaction } = vi.hoisted(() => ({
    uniqueConflictTransaction: {
        connectedServiceAuthGroup: {
            findUnique: vi.fn(async () => null),
            create: vi.fn(async () => {
                throw Object.assign(
                    new Error("qualified group already exists"),
                    { code: "P2002" },
                );
            }),
        },
    },
}));

vi.mock("@/storage/inTx", () => ({
    inTx: async (
        callback: (tx: typeof uniqueConflictTransaction) => Promise<unknown>,
    ) => await callback(uniqueConflictTransaction),
}));

describe("qualified Connected Account group repository", () => {
    it("projects one strict structured service identity", () => {
        expect(toQualifiedConnectedAccountGroup(row())).toMatchObject({
            ref: groupRef,
            incarnation: "group-row",
            policy: { strategy: "expiry_first" },
            activeConnectedAccountId: accountRef.accountId,
            members: [{
                connectedAccountId: accountRef.accountId,
            }],
        });
    });

    it("preserves an explicit predecessor pool strategy", () => {
        const current = row();
        current.policyJson = JSON.stringify({ strategy: "least_limited" });
        expect(toQualifiedConnectedAccountGroup(current).policy.strategy).toBe("least_limited");
    });

    it("exposes an active-since timestamp only for the active member it describes", () => {
        const current = row();
        current.stateJson = JSON.stringify({
            lastSwitchAt: 999,
            activeSince: { accountId: accountRef.accountId, atMs: 123 },
        });
        expect(toQualifiedConnectedAccountGroup(current).state.activeSince).toEqual({
            accountId: accountRef.accountId,
            atMs: 123,
        });
        expect(toQualifiedConnectedAccountGroup(current).state.lastSwitchAt).toBe(123);

        const divergentIdentityDigest = createQualifiedConnectedAccountIdentityDigest({
            service,
            accountId: "another-account",
        });
        const divergent = {
            ...current,
            activeConnectedAccountId: "another-account",
            members: current.members.map((member) => ({
                ...member,
                qualifiedIdentityDigest: divergentIdentityDigest,
                credential: {
                    ...member.credential,
                    connectedAccountId: "another-account",
                    qualifiedIdentityDigest: divergentIdentityDigest,
                },
            })),
        };
        expect(toQualifiedConnectedAccountGroup(divergent).state.activeSince).toBeNull();
        expect(toQualifiedConnectedAccountGroup(divergent).state.lastSwitchAt).toBeUndefined();
        expect(toQualifiedConnectedAccountGroup(row()).state.activeSince).toBeNull();
        // ../0.2 at 17ba05df68d4d3d4cad1c1241b58e63805db37ed permits this
        // state shape, but carries no identity-bound selection clock.
        const predecessor = row();
        predecessor.stateJson = JSON.stringify({ status: "ready", lastSwitchAt: 123 });
        expect(toQualifiedConnectedAccountGroup(predecessor).state).toMatchObject({
            status: "ready",
            activeSince: null,
        });
        expect(toQualifiedConnectedAccountGroup(predecessor).state.lastSwitchAt).toBeUndefined();
    });

    it("keeps the server-owned active time across runtime state writes and replaces it on switch", () => {
        expect(encodeQualifiedGroupStateForActiveAccount({
            currentStateJson: "{}",
            previousActiveAccountId: null,
            nextActiveAccountId: null,
        })).toBe("{}");
        const currentStateJson = JSON.stringify({
            status: "ready",
            lastSwitchAt: 10,
            activeSince: { accountId: "first", atMs: 10 },
        });
        const runtimeWrite = encodeQualifiedGroupStateForActiveAccount({
            currentStateJson,
            nextState: {
                status: "switching",
                lastSwitchAt: 999,
                activeSince: { accountId: "forged", atMs: 999 },
            },
            previousActiveAccountId: "first",
            nextActiveAccountId: "first",
            nowMs: 20,
        });
        expect(JSON.parse(runtimeWrite)).toMatchObject({
            status: "switching",
            lastSwitchAt: 10,
            activeSince: { accountId: "first", atMs: 10 },
        });
        const switched = encodeQualifiedGroupStateForActiveAccount({
            currentStateJson: runtimeWrite,
            previousActiveAccountId: "first",
            nextActiveAccountId: "second",
            nowMs: 30,
        });
        expect(JSON.parse(switched)).toMatchObject({
            lastSwitchAt: 30,
            activeSince: { accountId: "second", atMs: 30 },
        });
        const cleared = JSON.parse(encodeQualifiedGroupStateForActiveAccount({
            currentStateJson: switched,
            previousActiveAccountId: "second",
            nextActiveAccountId: null,
        }));
        expect(cleared.activeSince).toBeUndefined();
        expect(cleared.lastSwitchAt).toBeUndefined();
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

    it("lists every retained group the Account holds", async () => {
        // A predecessor or migration can leave more rows than a current create is
        // allowed to add. Refusing the whole list would take the Account's group
        // projection, and therefore every mutation that republishes it, offline.
        const storage = storageHolding(501);

        await expect(listAllQualifiedConnectedAccountGroupsInTx(storage, {
            accountId: "owner",
        })).resolves.toHaveLength(501);
    });

    it("does not page a retained group list down to a window", async () => {
        const storage = storageHolding(1_200);

        await expect(listAllQualifiedConnectedAccountGroupsInTx(storage, {
            accountId: "owner",
        })).resolves.toHaveLength(1_200);
    });
});

describe("createQualifiedConnectedAccountGroup", () => {
    it("maps a concurrent unique group-create conflict to the documented result", async () => {
        await expect(createQualifiedConnectedAccountGroup({
            accountId: "account-concurrent-create",
            service: {
                pluginId: "example.connected-accounts",
                localId: "service",
            },
            group: { groupId: "primary" },
        })).resolves.toEqual({ status: "already_exists" });
    });
});
