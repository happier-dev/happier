import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    initializeSessionSystemRecordsProtocolV1Activation,
    isSessionSystemRecordsProtocolV1Active,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
    SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION,
} from "./sessionSystemRecordProtocolContract";

// Prisma is the system boundary; keep activation independent of the record inventory.
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

    it("activates from the audited migration contract without reading the record inventory", async () => {
        const findMany = vi.fn().mockRejectedValue(new Error("record inventory must not be read at startup"));
        const query = vi.fn().mockResolvedValue([
            { migration_name: SESSION_SYSTEM_RECORDS_CONTRACT_MIGRATION },
        ]);

        await expect(initializeSessionSystemRecordsProtocolV1Activation({
            $queryRawUnsafe: query,
            sessionSystemRecord: { findMany },
        } as unknown as ProtocolActivationDatabase)).resolves.toBe(true);

        expect(query).toHaveBeenCalledTimes(1);
        expect(findMany).not.toHaveBeenCalled();
        expect(isSessionSystemRecordsProtocolV1Active()).toBe(true);
    });

    it("does not treat another migration or malformed ledger result as CONTRACT activation", async () => {
        for (const rows of [[{ migration_name: "expand-only" }], [null], {}]) {
            await expect(initializeSessionSystemRecordsProtocolV1Activation({
                $queryRawUnsafe: async () => rows,
            } as unknown as ProtocolActivationDatabase)).resolves.toBe(false);
            expect(isSessionSystemRecordsProtocolV1Active()).toBe(false);
        }
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
