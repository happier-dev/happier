import { describe, expect, it, vi } from "vitest";

import {
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
} from "./identity";

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
}));

// Prisma is the storage boundary. Everything below it — binding projection,
// ordering and the account/group source shapes — stays the real implementation.
vi.mock("@/storage/db", () => ({
    db: { connectedServiceUsageSource: { findMany: mocks.findMany } },
}));

import { listQualifiedUsageSourcesForRecord } from "./usageRepository";

const service = {
    pluginId: "acme.connected-accounts",
    localId: "git/hosting",
} as const;
const accountRef = { service, accountId: "provider/account" } as const;
const identityDigest =
    createQualifiedConnectedAccountIdentityDigest(accountRef);
const serviceDigest =
    createQualifiedConnectedAccountServiceDigest(service);

function credential() {
    return {
        id: "credential-row",
        accountId: "owner",
        servicePluginId: service.pluginId,
        serviceLocalId: service.localId,
        qualifiedServiceDigest: serviceDigest,
        connectedAccountId: accountRef.accountId,
        qualifiedIdentityDigest: identityDigest,
    };
}

/**
 * One account binding plus one binding per group the credential belongs to —
 * exactly what the writers produce for a single Provider subject. `take` is
 * honoured so a reader that keeps a page window truncates here as it would
 * against the database.
 */
function storedSources(groupCount: number) {
    return [
        {
            ...credential(),
            credentialId: "credential-row",
            bindingKind: "account",
            groupId: null,
            groupGeneration: null,
            credential: credential(),
        },
        ...Array.from({ length: groupCount }, (_, index) => ({
            ...credential(),
            credentialId: "credential-row",
            bindingKind: "group_member",
            groupId: `fallback-${index}`,
            groupGeneration: 1,
            credential: credential(),
        })),
    ];
}

describe("qualified provider usage sources", () => {
    it("opens a record linked through every one of its sources", async () => {
        // 500 groups is the most a current writer will admit, and each one adds a
        // source alongside the account binding. Refusing to list them would make the
        // record's own GET, DELETE and refresh routes fail on stored, valid data.
        const rows = storedSources(500);
        mocks.findMany.mockImplementation(
            async (args: Readonly<{ take?: number }>) => (
                typeof args.take === "number" ? rows.slice(0, args.take) : rows
            ),
        );

        await expect(listQualifiedUsageSourcesForRecord({
            accountId: "owner",
            recordId: "record-1",
        })).resolves.toHaveLength(501);
    });
});
