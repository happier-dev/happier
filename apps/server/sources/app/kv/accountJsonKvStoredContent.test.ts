import { describe, expect, it } from "vitest";

import {
    assertAccountJsonKvAccountEncryptionTransitionStoredContent,
    assertAccountJsonKvMutationStoredContent,
    assertAccountJsonKvStoredContentMatchesAccountMode,
    classifyAccountJsonKvStoredContent,
    AccountJsonKvStoredContentModeMismatchError,
    AccountJsonKvStoredContentUpgradeRequiredError,
} from "./accountJsonKvStoredContent";

function encodeEnvelope(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}

// remote-dev ba6ecc07: Encryption.encryptRaw stores nonce ||
// crypto_secretbox_easy(JSON), then KV base64-decodes it back to these bytes.
const RELEASED_SECRETBOX_TODO_BYTES = Buffer.from(
    "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJr91zgQjd2U84B/OLFWa+t/doZphbPlyJSwZ2jdgWjwk9saxROyK+se1SiWqotjQNPveX1Iru",
    "base64",
);

describe("classifyAccountJsonKvStoredContent", () => {
    it('applies Account-mode envelope admission to Coach dismissals', () => {
        const key = 'workspace:usage-coach:suppressions';
        for (const mode of ['plain', 'e2ee'] as const) {
            const plain = encodeEnvelope({ t: 'plain', v: { v: 1, suppressions: [] } });
            const encrypted = encodeEnvelope({ t: 'encrypted', c: 'ciphertext' });
            expect(() => assertAccountJsonKvStoredContentMatchesAccountMode({ key, value: mode === 'plain' ? plain : encrypted, accountMode: mode })).not.toThrow();
            expect(() => assertAccountJsonKvStoredContentMatchesAccountMode({ key, value: mode === 'plain' ? encrypted : plain, accountMode: mode })).toThrow(AccountJsonKvStoredContentModeMismatchError);
        }
    });
    it("keeps task resource ciphertext distinct from Account ciphertext and refuses raw reads and writes", () => {
        const value = encodeEnvelope({ t: "encrypted", k: "task", c: "task-ciphertext" });
        expect(classifyAccountJsonKvStoredContent({ key: "todo.task-1", value })).toEqual({
            domain: "todo", keyKind: "item", representation: "current_resource_encrypted",
        });
        expect(() => assertAccountJsonKvStoredContentMatchesAccountMode({
            key: "todo.task-1", value, accountMode: "e2ee",
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
        for (const persistedValue of [null, value]) {
            for (const nextValue of [value, encodeEnvelope({ t: "encrypted", c: "account-ciphertext" }), null]) {
                if (persistedValue === null && nextValue !== value) continue;
                expect(() => assertAccountJsonKvMutationStoredContent({
                    key: "todo.task-1", persistedValue, nextValue, accountMode: "e2ee", supportsCurrentProtocol: true,
                })).toThrow(AccountJsonKvStoredContentModeMismatchError);
            }
        }
        expect(() => assertAccountJsonKvMutationStoredContent({
            key: "todo.task-1", persistedValue: value, nextValue: null,
            accountMode: "e2ee", supportsCurrentProtocol: false,
        })).toThrow(AccountJsonKvStoredContentUpgradeRequiredError);
    });

    it.each(["todo.index", "workspace:one"])("does not admit a task marker at %s", (key) => {
        expect(classifyAccountJsonKvStoredContent({
            key, value: encodeEnvelope({ t: "encrypted", k: "task", c: "ciphertext" }),
        })).toMatchObject({ representation: "malformed_marker" });
    });

    it("admits task ciphertext only to the task owner codec under the persisted E2EE mode", () => {
        const value = encodeEnvelope({ t: "encrypted", k: "task", c: "task-ciphertext" });
        expect(() => assertAccountJsonKvStoredContentMatchesAccountMode({
            key: "todo.task-1", value, accountMode: "e2ee", usage: "task_resource",
        })).not.toThrow();
        expect(() => assertAccountJsonKvStoredContentMatchesAccountMode({
            key: "todo.task-1", value, accountMode: "plain", usage: "task_resource",
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
        expect(() => assertAccountJsonKvMutationStoredContent({
            key: "todo.task-1", persistedValue: value, nextValue: value,
            accountMode: "e2ee", supportsCurrentProtocol: true, usage: "task_resource",
        })).not.toThrow();
        expect(() => assertAccountJsonKvMutationStoredContent({
            key: "todo.task-1", persistedValue: value, nextValue: encodeEnvelope({ t: "encrypted", c: "account" }),
            accountMode: "e2ee", supportsCurrentProtocol: true, usage: "task_resource",
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
    });

    it("admits only an E2EE task promotion from Account ciphertext into the task key codec", () => {
        const resource = encodeEnvelope({ t: "encrypted", k: "task", c: "resource" });
        const encrypted = encodeEnvelope({ t: "encrypted", c: "account" });
        for (const persistedValue of [RELEASED_SECRETBOX_TODO_BYTES, encrypted]) {
            expect(() => assertAccountJsonKvMutationStoredContent({
                key: "todo.task-1", persistedValue, nextValue: resource,
                accountMode: "e2ee", supportsCurrentProtocol: true, usage: "task_resource_promotion",
            })).not.toThrow();
        }
        for (const persistedValue of [null, resource, encodeEnvelope({ t: "plain", v: {} })]) {
            expect(() => assertAccountJsonKvMutationStoredContent({
                key: "todo.task-1", persistedValue, nextValue: resource,
                accountMode: "e2ee", supportsCurrentProtocol: true, usage: "task_resource_promotion",
            })).toThrow(AccountJsonKvStoredContentModeMismatchError);
        }
        expect(() => assertAccountJsonKvMutationStoredContent({
            key: "todo.task-1", persistedValue: encrypted, nextValue: resource,
            accountMode: "plain", supportsCurrentProtocol: true, usage: "task_resource_promotion",
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
    });

    it("classifies canonical Todo keys without inspecting unrelated KV content", () => {
        const marker = encodeEnvelope({ t: "plain", v: { undoneOrder: [], completedOrder: [] } });

        expect(classifyAccountJsonKvStoredContent({
            key: "todo.index",
            value: marker,
        })).toEqual({
            domain: "todo",
            keyKind: "index",
            representation: "current_plain",
        });
        expect(classifyAccountJsonKvStoredContent({
            key: "todo.123",
            value: marker,
        })).toEqual({
            domain: "todo",
            keyKind: "item",
            representation: "current_plain",
        });
        expect(classifyAccountJsonKvStoredContent({
            key: "todo.",
            value: marker,
        })).toEqual({ domain: "generic" });
        expect(classifyAccountJsonKvStoredContent({
            key: "preferences",
            value: marker,
        })).toEqual({ domain: "generic" });
    });

    it("uses canonical StoredJson envelope semantics and preserves legacy ciphertext", () => {
        expect(classifyAccountJsonKvStoredContent({
            key: "todo.index",
            value: encodeEnvelope({ t: "encrypted", c: "legacy-ciphertext" }),
        })).toEqual({
            domain: "todo",
            keyKind: "index",
            representation: "current_encrypted",
        });
        expect(classifyAccountJsonKvStoredContent({
            key: "todo.index",
            value: RELEASED_SECRETBOX_TODO_BYTES,
        })).toEqual({
            domain: "todo",
            keyKind: "index",
            representation: "legacy_encrypted",
        });
    });

    it.each([
        {
            name: "empty encrypted marker",
            value: { t: "encrypted", c: "" },
        },
        {
            name: "future marker",
            value: { t: "future", v: { undoneOrder: [] } },
        },
        {
            name: "incomplete plain marker",
            value: { t: "plain" },
        },
        {
            name: "empty task ciphertext",
            value: { t: "encrypted", k: "task", c: "" },
        },
        {
            name: "task marker with unknown fields",
            value: { t: "encrypted", k: "task", c: "ciphertext", extra: true },
        },
        {
            name: "unknown key purpose",
            value: { t: "encrypted", k: "future", c: "ciphertext" },
        },
    ])("classifies a $name as malformed marker content and refuses it for E2EE", ({ value }) => {
        const bytes = encodeEnvelope(value);
        expect(classifyAccountJsonKvStoredContent({
            key: "todo.index",
            value: bytes,
        })).toEqual({
            domain: "todo",
            keyKind: "index",
            representation: "malformed_marker",
        });
        expect(() => assertAccountJsonKvStoredContentMatchesAccountMode({
            key: "todo.index",
            value: bytes,
            accountMode: "e2ee",
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
        expect(() => assertAccountJsonKvMutationStoredContent({
            key: "todo.index",
            persistedValue: bytes,
            nextValue: null,
            accountMode: "e2ee",
            supportsCurrentProtocol: false,
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
    });

    it("continues to admit strict current envelopes and released opaque ciphertext", () => {
        for (const value of [
            encodeEnvelope({ t: "plain", v: { undoneOrder: [] } }),
            encodeEnvelope({ t: "encrypted", c: "ciphertext" }),
        ]) {
            expect(classifyAccountJsonKvStoredContent({
                key: "todo.index",
                value,
            })).toMatchObject({
                domain: "todo",
                representation: expect.stringMatching(/^current_/),
            });
        }
        expect(() => assertAccountJsonKvMutationStoredContent({
            key: "todo.index",
            persistedValue: RELEASED_SECRETBOX_TODO_BYTES,
            nextValue: null,
            accountMode: "e2ee",
            supportsCurrentProtocol: false,
        })).not.toThrow();
    });

    it("admits current Todo marker writes only after protocol support is negotiated", () => {
        const mutation = {
            key: "todo.index",
            persistedValue: null,
            nextValue: encodeEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
            accountMode: "plain",
        } as const;

        expect(() => assertAccountJsonKvMutationStoredContent({
            ...mutation,
            supportsCurrentProtocol: false,
        })).toThrow(AccountJsonKvStoredContentUpgradeRequiredError);
        expect(() => assertAccountJsonKvMutationStoredContent({
            ...mutation,
            supportsCurrentProtocol: true,
        })).not.toThrow();
    });

    it.each([
        {
            accountMode: "plain" as const,
            persistedValue: new TextEncoder().encode(
                "released-e2ee-ciphertext",
            ),
            nextValue: new TextEncoder().encode(
                "replacement-e2ee-ciphertext",
            ),
        },
        {
            accountMode: "e2ee" as const,
            persistedValue: encodeEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
            nextValue: encodeEnvelope({
                t: "plain",
                v: { undoneOrder: ["todo-1"], completedOrder: [] },
            }),
        },
    ])("rejects existing $accountMode Account rows whose persisted and next Todo envelopes agree with each other but not the Account", ({
        accountMode,
        persistedValue,
        nextValue,
    }) => {
        expect(() => assertAccountJsonKvMutationStoredContent({
            key: "todo.index",
            persistedValue,
            nextValue,
            accountMode,
            supportsCurrentProtocol: true,
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
    });

    it.each([
        {
            fromMode: "plain" as const,
            toMode: "e2ee" as const,
            persistedValue: new TextEncoder().encode(
                "already-e2ee-ciphertext",
            ),
            nextValue: new TextEncoder().encode(
                "target-e2ee-ciphertext",
            ),
        },
        {
            fromMode: "e2ee" as const,
            toMode: "plain" as const,
            persistedValue: encodeEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
            nextValue: encodeEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
        },
    ])("requires transition inventory to match exact $fromMode source and $toMode target Todo modes", ({
        fromMode,
        toMode,
        persistedValue,
        nextValue,
    }) => {
        expect(() => assertAccountJsonKvAccountEncryptionTransitionStoredContent({
            key: "todo.index",
            persistedValue,
            nextValue,
            fromMode,
            toMode,
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
    });

    it("rejects a same-mode transition instead of treating a mismatched source row as migration input", () => {
        expect(() => assertAccountJsonKvAccountEncryptionTransitionStoredContent({
            key: "todo.index",
            persistedValue: new TextEncoder().encode(
                "released-e2ee-ciphertext",
            ),
            nextValue: encodeEnvelope({
                t: "plain",
                v: { undoneOrder: [], completedOrder: [] },
            }),
            fromMode: "plain",
            toMode: "plain",
        })).toThrow(AccountJsonKvStoredContentModeMismatchError);
    });
});
