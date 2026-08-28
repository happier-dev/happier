import { describe, expect, it, vi } from "vitest";

import {
    auditSessionSystemRecordAddressesPage,
    backfillSessionSystemRecordAddressesPage,
} from "./backfillSessionSystemRecordAddresses";
import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";

describe("auditSessionSystemRecordAddressesPage", () => {
    it("rejects a canonical address row with an invalid persisted revision version", async () => {
        const keys = deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace: "memory",
            localId: "memory:synopsis:v1:1",
        });
        const findMany = vi.fn(async () => [{
            id: "record-one",
            ownerKind: "host",
            pluginId: null,
            namespace: "memory",
            localId: "memory:synopsis:v1:1",
            namespaceAddressKey: keys.namespaceAddressKey,
            recordAddressKey: keys.recordAddressKey,
            version: 0,
        }]);
        // Prisma is the system boundary; this fixture implements only the selected audit operation.
        const db = {
            sessionSystemRecord: { findMany },
        } as unknown as Parameters<typeof auditSessionSystemRecordAddressesPage>[0]["db"];

        await expect(auditSessionSystemRecordAddressesPage({ db })).resolves.toMatchObject({
            processed: 1,
            nullRows: 0,
            mismatchedRows: 1,
        });
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({ version: true }),
        }));
    });
});

describe("backfillSessionSystemRecordAddressesPage", () => {
    it.each([
        ["postgres", '"SessionSystemRecord"', '"ownerKind"', "$1", "$2"],
        ["pglite", '"SessionSystemRecord"', '"ownerKind"', "$1", "$2"],
        ["sqlite", '"SessionSystemRecord"', '"ownerKind"', "?", "?"],
        ["mysql", "`SessionSystemRecord`", "`ownerKind`", "?", "?"],
    ] as const)("uses parameterized %s SQL with provider-correct identifiers", async (
        provider,
        expectedTable,
        expectedOwnerKind,
        expectedAfterPlaceholder,
        expectedLimitPlaceholder,
    ) => {
        let capturedQuery: string | undefined;
        let capturedValues: readonly unknown[] | undefined;
        const queryRawUnsafe = vi.fn(async (query: string, ...values: readonly unknown[]) => {
            capturedQuery = query;
            capturedValues = values;
            return [{
                id: "record-one",
                namespace: "memory",
                localId: "memory:synopsis:v1:1",
            }];
        });
        const updateMany = vi.fn(async () => ({ count: 1 }));
        // Prisma is the system boundary; this fixture records the generated statement and result write.
        const db = {
            $queryRawUnsafe: queryRawUnsafe,
            sessionSystemRecord: { updateMany },
        } as unknown as Parameters<typeof backfillSessionSystemRecordAddressesPage>[0]["db"];

        await expect(backfillSessionSystemRecordAddressesPage({
            db,
            provider,
            afterId: "record-zero",
            limit: 25,
        })).resolves.toEqual({
            processed: 1,
            updated: 1,
            nextAfterId: null,
        });

        const sql = capturedQuery ?? "";
        expect(sql).toContain(`FROM ${expectedTable}`);
        expect(sql).toContain(`${expectedOwnerKind} IS NULL`);
        expect(sql).toContain(`AND ${provider === "mysql" ? "`id`" : '"id"'} > ${expectedAfterPlaceholder}`);
        expect(sql).toContain(`LIMIT ${expectedLimitPlaceholder}`);
        expect(sql).not.toContain("record-zero");
        expect(sql).not.toContain("LIMIT 25");
        expect(capturedValues).toEqual(["record-zero", 25]);
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "record-one" },
        }));
    });

    it("numbers the PostgreSQL limit placeholder from the first bound value when no cursor exists", async () => {
        const queryRawUnsafe = vi.fn(async () => []);
        const db = {
            $queryRawUnsafe: queryRawUnsafe,
            sessionSystemRecord: { updateMany: vi.fn() },
        } as unknown as Parameters<typeof backfillSessionSystemRecordAddressesPage>[0]["db"];

        await expect(backfillSessionSystemRecordAddressesPage({
            db,
            provider: "postgres",
            limit: 25,
        })).resolves.toEqual({
            processed: 0,
            updated: 0,
            nextAfterId: null,
        });

        expect(queryRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining("LIMIT $1"),
            25,
        );
    });
});
