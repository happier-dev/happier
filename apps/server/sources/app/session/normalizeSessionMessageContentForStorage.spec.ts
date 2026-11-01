import { describe, expect, it } from "vitest";
import { normalizeSessionMessageContentForStorage } from "./normalizeSessionMessageContentForStorage";

describe("normalizeSessionMessageContentForStorage", () => {
    it("preserves ordinary values and ciphertext without changing their identity", () => {
        for (const content of [
            { t: "encrypted", c: "base64ciphertext==" },
            { t: "plain", v: { value: "\\u0000\n\r\t\b\f😀", empty: null, number: 1, bool: false, array: [] } },
        ] satisfies PrismaJson.SessionMessageContent[]) {
            expect(normalizeSessionMessageContentForStorage(content)).toBe(content);
        }
    });

    it("strips actual NULs recursively without mutating the input or special keys", () => {
        const content = { t: "plain", v: JSON.parse('{"__proto__":"x\\u0000y","nested":[null,{"text":"a\\u0000b"}]}') } satisfies PrismaJson.SessionMessageContent;
        expect(normalizeSessionMessageContentForStorage(content)).toEqual({ t: "plain", v: JSON.parse('{"__proto__":"xy","nested":[null,{"text":"ab"}]}') });
        expect(JSON.stringify(content)).toContain('\\u0000');
    });

    it("rejects NUL-bearing keys and ciphertext instead of corrupting identities", () => {
        expect(normalizeSessionMessageContentForStorage({ t: "encrypted", c: "cipher\u0000text" })).toBeNull();
        expect(normalizeSessionMessageContentForStorage({ t: "plain", v: [{ "key\u0000": 1, key: 2 }] })).toBeNull();
    });
});
