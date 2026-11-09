import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ findUnique: vi.fn() }));
// The database is the system boundary; conflict admission and classification stay real.
vi.mock("@/storage/db", () => ({ db: { userKVStore: { findUnique: database.findUnique } } }));

import { assertAccountJsonKvMutationStoredContent, AccountJsonKvStoredContentModeMismatchError } from "./accountJsonKvStoredContent";
import { readUserKvMutationConflict, UserKvMutationConflictError } from "./kvMutate";

describe("KV conflict content admission", () => {
    beforeEach(() => vi.clearAllMocks());

    it("refuses task ciphertext that replaced the admitted Account ciphertext before the conflict reread", async () => {
        const promoted = new TextEncoder().encode(JSON.stringify({ t: "encrypted", k: "task", c: "task-ciphertext" }));
        database.findUnique.mockResolvedValue({ value: promoted, version: 8 });
        await expect(readUserKvMutationConflict(new UserKvMutationConflictError("owner", "todo.task-1"), current => {
            assertAccountJsonKvMutationStoredContent({
                key: current.key, persistedValue: current.value, nextValue: null,
                accountMode: "e2ee", supportsCurrentProtocol: true,
            });
        })).rejects.toBeInstanceOf(AccountJsonKvStoredContentModeMismatchError);
    });
});
