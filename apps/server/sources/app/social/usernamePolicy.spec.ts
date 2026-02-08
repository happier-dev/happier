import { describe, expect, it } from "vitest";

import { normalizeUsername, resolveUsernamePolicyFromEnv, validateUsername } from "./usernamePolicy";

describe("social/usernamePolicy", () => {
    it("normalizes usernames by trimming and lowercasing", () => {
        expect(normalizeUsername("  Foo_Bar  ")).toBe("foo_bar");
    });

    it("uses safe defaults when env is invalid", () => {
        const policy = resolveUsernamePolicyFromEnv({
            FRIENDS_USERNAME_MIN_LEN: "nope",
            FRIENDS_USERNAME_MAX_LEN: "-1",
            FRIENDS_USERNAME_REGEX: "[invalid",
        });
        expect(policy.minLen).toBeGreaterThan(0);
        expect(policy.maxLen).toBeGreaterThan(0);
        expect(policy.pattern.test("abc")).toBe(true);
    });

    it("validates length and pattern", () => {
        const env = {
            FRIENDS_USERNAME_MIN_LEN: "3",
            FRIENDS_USERNAME_MAX_LEN: "5",
            FRIENDS_USERNAME_REGEX: "^[a-z]+$",
        };
        expect(validateUsername("ab", env).ok).toBe(false);
        expect(validateUsername("abcdef", env).ok).toBe(false);
        expect(validateUsername("ab_1", env).ok).toBe(false);
        expect(validateUsername("abcd", env).ok).toBe(true);
    });

    it("does not reuse cached policy when env values change", () => {
        const envA = {
            FRIENDS_USERNAME_MIN_LEN: "3",
            FRIENDS_USERNAME_MAX_LEN: "32",
            FRIENDS_USERNAME_REGEX: "^[a-z]+$",
        };
        const envB = {
            FRIENDS_USERNAME_MIN_LEN: "3",
            FRIENDS_USERNAME_MAX_LEN: "32",
            FRIENDS_USERNAME_REGEX: "^[a-z0-9]+$",
        };

        expect(resolveUsernamePolicyFromEnv(envA).pattern.test("abc")).toBe(true);
        expect(resolveUsernamePolicyFromEnv(envA).pattern.test("abc1")).toBe(false);

        expect(resolveUsernamePolicyFromEnv(envB).pattern.test("abc")).toBe(true);
        expect(resolveUsernamePolicyFromEnv(envB).pattern.test("abc1")).toBe(true);
    });
});
