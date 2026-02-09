import { describe, expect, it } from "vitest";
import { separateName } from "./separateName";

describe("separateName", () => {
    it.each([
        {
            label: "basic first and last name",
            input: "John Doe",
            expected: { firstName: "John", lastName: "Doe" },
        },
        {
            label: "single name with no last name",
            input: "John",
            expected: { firstName: "John", lastName: null },
        },
        {
            label: "multiple names with merged lastName",
            input: "John William Doe Smith",
            expected: { firstName: "John", lastName: "William Doe Smith" },
        },
        {
            label: "empty string",
            input: "",
            expected: { firstName: null, lastName: null },
        },
        {
            label: "null input",
            input: null,
            expected: { firstName: null, lastName: null },
        },
        {
            label: "undefined input",
            input: undefined,
            expected: { firstName: null, lastName: null },
        },
        {
            label: "whitespace-only string",
            input: "   ",
            expected: { firstName: null, lastName: null },
        },
        {
            label: "extra spaces between names",
            input: "  John    Doe  ",
            expected: { firstName: "John", lastName: "Doe" },
        },
        {
            label: "special characters",
            input: "José María",
            expected: { firstName: "José", lastName: "María" },
        },
        {
            label: "hyphenated last names",
            input: "Mary Smith-Johnson",
            expected: { firstName: "Mary", lastName: "Smith-Johnson" },
        },
        {
            label: "multiple middle names with hyphenated last name",
            input: "John Michael Robert Smith-Johnson",
            expected: { firstName: "John", lastName: "Michael Robert Smith-Johnson" },
        },
    ])("handles $label", ({ input, expected }) => {
        expect(separateName(input)).toEqual(expected);
    });
});
