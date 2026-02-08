import { describe, expect, it } from "vitest";

import { parseBooleanEnv, parseIntEnv } from "./env";

describe("config/env", () => {
    describe("parseBooleanEnv", () => {
        it("returns fallback for undefined and empty strings", () => {
            expect(parseBooleanEnv(undefined, true)).toBe(true);
            expect(parseBooleanEnv(undefined, false)).toBe(false);
            expect(parseBooleanEnv("", true)).toBe(true);
            expect(parseBooleanEnv("   ", false)).toBe(false);
        });

        it("parses true-ish tokens", () => {
            for (const token of ["1", "true", "TRUE", " yes ", "Y", "on", " On "]) {
                expect(parseBooleanEnv(token, false)).toBe(true);
            }
        });

        it("parses false-ish tokens", () => {
            for (const token of ["0", "false", "FALSE", " no ", "N", "off", " Off "]) {
                expect(parseBooleanEnv(token, true)).toBe(false);
            }
        });

        it("returns fallback for unknown tokens", () => {
            expect(parseBooleanEnv("nope", true)).toBe(true);
            expect(parseBooleanEnv("nope", false)).toBe(false);
        });
    });

    describe("parseIntEnv", () => {
        it("returns fallback when unset or invalid", () => {
            expect(parseIntEnv(undefined, 7)).toBe(7);
            expect(parseIntEnv("", 7)).toBe(7);
            expect(parseIntEnv("wat", 7)).toBe(7);
        });

        it("parses integers with trimming", () => {
            expect(parseIntEnv(" 10 ", 0)).toBe(10);
        });

        it("respects min and max constraints", () => {
            expect(parseIntEnv("0", 3, { min: 1 })).toBe(3);
            expect(parseIntEnv("1", 3, { min: 1 })).toBe(1);
            expect(parseIntEnv("999", 3, { max: 10 })).toBe(3);
            expect(parseIntEnv("10", 3, { max: 10 })).toBe(10);
        });
    });
});

