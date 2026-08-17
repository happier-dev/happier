import { describe, expect, it } from "vitest";

import {
    assertTodoKvAccountEncryptionTransitionStoredContent,
    assertTodoKvMutationStoredContent,
    assertTodoKvStoredContentMatchesAccountMode,
    classifyTodoKvStoredContent,
    TodoKvStoredContentModeMismatchError,
    TodoKvStoredContentUpgradeRequiredError,
} from "./todoKvStoredContent";

function encodeEnvelope(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}

// remote-dev ba6ecc07: Encryption.encryptRaw stores nonce ||
// crypto_secretbox_easy(JSON), then KV base64-decodes it back to these bytes.
const RELEASED_SECRETBOX_TODO_BYTES = Buffer.from(
    "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJr91zgQjd2U84B/OLFWa+t/doZphbPlyJSwZ2jdgWjwk9saxROyK+se1SiWqotjQNPveX1Iru",
    "base64",
);

describe("classifyTodoKvStoredContent", () => {
    it("classifies canonical Todo keys without inspecting unrelated KV content", () => {
        const marker = encodeEnvelope({ t: "plain", v: { undoneOrder: [], completedOrder: [] } });

        expect(classifyTodoKvStoredContent({
            key: "todo.index",
            value: marker,
        })).toEqual({
            domain: "todo",
            keyKind: "index",
            representation: "current_plain",
        });
        expect(classifyTodoKvStoredContent({
            key: "todo.123",
            value: marker,
        })).toEqual({
            domain: "todo",
            keyKind: "item",
            representation: "current_plain",
        });
        expect(classifyTodoKvStoredContent({
            key: "todo.",
            value: marker,
        })).toEqual({ domain: "generic" });
        expect(classifyTodoKvStoredContent({
            key: "preferences",
            value: marker,
        })).toEqual({ domain: "generic" });
    });

    it("uses canonical StoredJson envelope semantics and preserves legacy ciphertext", () => {
        expect(classifyTodoKvStoredContent({
            key: "todo.index",
            value: encodeEnvelope({ t: "encrypted", c: "legacy-ciphertext" }),
        })).toEqual({
            domain: "todo",
            keyKind: "index",
            representation: "current_encrypted",
        });
        expect(classifyTodoKvStoredContent({
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
    ])("classifies a $name as malformed marker content and refuses it for E2EE", ({ value }) => {
        const bytes = encodeEnvelope(value);
        expect(classifyTodoKvStoredContent({
            key: "todo.index",
            value: bytes,
        })).toEqual({
            domain: "todo",
            keyKind: "index",
            representation: "malformed_marker",
        });
        expect(() => assertTodoKvStoredContentMatchesAccountMode({
            key: "todo.index",
            value: bytes,
            accountMode: "e2ee",
        })).toThrow(TodoKvStoredContentModeMismatchError);
        expect(() => assertTodoKvMutationStoredContent({
            key: "todo.index",
            persistedValue: bytes,
            nextValue: null,
            accountMode: "e2ee",
            supportsCurrentProtocol: false,
        })).toThrow(TodoKvStoredContentModeMismatchError);
    });

    it("continues to admit strict current envelopes and released opaque ciphertext", () => {
        for (const value of [
            encodeEnvelope({ t: "plain", v: { undoneOrder: [] } }),
            encodeEnvelope({ t: "encrypted", c: "ciphertext" }),
        ]) {
            expect(classifyTodoKvStoredContent({
                key: "todo.index",
                value,
            })).toMatchObject({
                domain: "todo",
                representation: expect.stringMatching(/^current_/),
            });
        }
        expect(() => assertTodoKvMutationStoredContent({
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

        expect(() => assertTodoKvMutationStoredContent({
            ...mutation,
            supportsCurrentProtocol: false,
        })).toThrow(TodoKvStoredContentUpgradeRequiredError);
        expect(() => assertTodoKvMutationStoredContent({
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
        expect(() => assertTodoKvMutationStoredContent({
            key: "todo.index",
            persistedValue,
            nextValue,
            accountMode,
            supportsCurrentProtocol: true,
        })).toThrow(TodoKvStoredContentModeMismatchError);
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
        expect(() => assertTodoKvAccountEncryptionTransitionStoredContent({
            key: "todo.index",
            persistedValue,
            nextValue,
            fromMode,
            toMode,
        })).toThrow(TodoKvStoredContentModeMismatchError);
    });

    it("rejects a same-mode transition instead of treating a mismatched source row as migration input", () => {
        expect(() => assertTodoKvAccountEncryptionTransitionStoredContent({
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
        })).toThrow(TodoKvStoredContentModeMismatchError);
    });
});
