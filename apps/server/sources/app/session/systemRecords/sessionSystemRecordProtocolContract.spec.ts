import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    initializeSessionSystemRecordsProtocolV1Activation,
    isSessionSystemRecordsProtocolV1Active,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
    SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
} from "./sessionSystemRecordProtocolContract";

// Prisma is the system boundary; these fixtures expose only the audited findMany operation.
type ProtocolActivationDatabase = Parameters<typeof initializeSessionSystemRecordsProtocolV1Activation>[0];

describe("Session System Records protocol-v1 database contract", () => {
    beforeEach(() => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
    });

    it("activates only after the finished canonical CONTRACT migration", async () => {
        const query = vi.fn().mockResolvedValue([
            { migration_name: SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION },
        ]);

        await expect(initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: query,
            sessionSystemRecord: {
                findMany: vi.fn().mockResolvedValue([]),
            },
        } as unknown as ProtocolActivationDatabase)).resolves.toBe(true);
        expect(isSessionSystemRecordsProtocolV1Active()).toBe(true);
        expect(query).toHaveBeenCalledWith(expect.stringContaining(
            `migration_name = '${SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION}'`,
        ));
        expect(query).toHaveBeenCalledWith(expect.stringContaining(
            "finished_at IS NOT NULL AND rolled_back_at IS NULL",
        ));
    });

    it("keeps v1 inactive when the final current-version audit finds a legacy row", async () => {
        const findMany = vi.fn().mockResolvedValue([
            {
                id: "legacy-row",
                ownerKind: null,
                pluginId: null,
                namespace: "memory",
                localId: "memory:synopsis:v1:1",
                namespaceAddressKey: null,
                recordAddressKey: null,
                version: 1,
            },
        ]);

        await expect(initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: vi.fn().mockResolvedValue([
                { migration_name: SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION },
            ]),
            sessionSystemRecord: { findMany },
        } as unknown as ProtocolActivationDatabase)).resolves.toBe(false);

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            orderBy: { id: "asc" },
            take: expect.any(Number),
        }));
        expect(isSessionSystemRecordsProtocolV1Active()).toBe(false);
    });

    it("keeps v1 inactive without preventing an expanded-only server from starting", async () => {
        await expect(initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: vi.fn().mockResolvedValue([]),
            sessionSystemRecord: {
                findMany: vi.fn().mockResolvedValue([]),
            },
        } as unknown as ProtocolActivationDatabase)).resolves.toBe(false);
        expect(isSessionSystemRecordsProtocolV1Active()).toBe(false);
    });

    it("fails closed when the migration ledger cannot be inspected", async () => {
        await expect(initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("migration ledger unavailable")),
            sessionSystemRecord: {
                findMany: vi.fn().mockResolvedValue([]),
            },
        } as unknown as ProtocolActivationDatabase)).resolves.toBe(false);
        expect(isSessionSystemRecordsProtocolV1Active()).toBe(false);
    });
});
