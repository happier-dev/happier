import { describe, expect, it } from "vitest";

import {
  QualifiedConnectedAccountConfigurationTargetV4Schema,
  QualifiedConnectedAccountGroupRefSchema,
  QualifiedConnectedAccountRefSchema,
  QualifiedConnectedAccountServiceRefSchema,
  QualifiedConnectedServiceUsageSourceV4Schema,
} from "./qualifiedConnectedAccountsV4.js";
import {
  encodeQualifiedConnectedAccountV4StructuredQueryValue,
  parseQualifiedConnectedAccountV4BooleanQueryValue,
  parseQualifiedConnectedAccountV4NonnegativeIntegerQueryValue,
  parseQualifiedConnectedAccountV4StructuredQueryValue,
} from "./qualifiedConnectedAccountsV4QueryCodec.js";

const service = {
  pluginId: "example.connected-accounts",
  localId: "service/with/path",
} as const;
const ref = {
  service,
  accountId: "provider/account/with/path",
} as const;

function readFastifyStyleQueryValue(url: URL, name: string): unknown {
  const all = url.searchParams.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0] : all;
}

describe("qualified Connected Account V4 query codec", () => {
  it.each([
    ["service", service, QualifiedConnectedAccountServiceRefSchema],
    ["ref", ref, QualifiedConnectedAccountRefSchema],
    [
      "target",
      { kind: "account", ref },
      QualifiedConnectedAccountConfigurationTargetV4Schema,
    ],
    [
      "group",
      { service, groupId: "group.with.path" },
      QualifiedConnectedAccountGroupRefSchema,
    ],
    [
      "source",
      {
        ref,
        bindingKind: "group_member",
        groupId: "group.with.path",
        groupGeneration: 7,
      },
      QualifiedConnectedServiceUsageSourceV4Schema,
    ],
  ] as const)(
    "round-trips a percent-encoded path-containing %s value",
    (name, value, schema) => {
      const url = new URL("https://example.invalid/v4");
      url.searchParams.set(
        name,
        encodeQualifiedConnectedAccountV4StructuredQueryValue(schema, value),
      );
      expect(url.toString()).toContain("%2F");
      expect(parseQualifiedConnectedAccountV4StructuredQueryValue(
        schema,
        readFastifyStyleQueryValue(url, name),
      )).toEqual(value);
    },
  );

  it("rejects duplicate, malformed, non-record, unknown, and oversized structured fields", () => {
    const url = new URL("https://example.invalid/v4");
    url.searchParams.append(
      "ref",
      encodeQualifiedConnectedAccountV4StructuredQueryValue(
        QualifiedConnectedAccountRefSchema,
        ref,
      ),
    );
    url.searchParams.append(
      "ref",
      encodeQualifiedConnectedAccountV4StructuredQueryValue(
        QualifiedConnectedAccountRefSchema,
        ref,
      ),
    );
    for (const raw of [
      readFastifyStyleQueryValue(url, "ref"),
      "{",
      "null",
      "[]",
      JSON.stringify({ ...ref, serviceId: "legacy" }),
      "x".repeat(16_385),
    ]) {
      expect(() =>
        parseQualifiedConnectedAccountV4StructuredQueryValue(
          QualifiedConnectedAccountRefSchema,
          raw,
        ),
      ).toThrow();
    }
  });

  it("parses only exact URL booleans and canonical nonnegative integers", () => {
    expect(parseQualifiedConnectedAccountV4BooleanQueryValue("true"))
      .toBe(true);
    expect(parseQualifiedConnectedAccountV4BooleanQueryValue("false"))
      .toBe(false);
    expect(parseQualifiedConnectedAccountV4BooleanQueryValue(undefined))
      .toBeUndefined();
    expect(parseQualifiedConnectedAccountV4NonnegativeIntegerQueryValue("0"))
      .toBe(0);
    expect(parseQualifiedConnectedAccountV4NonnegativeIntegerQueryValue("7"))
      .toBe(7);
    expect(
      parseQualifiedConnectedAccountV4NonnegativeIntegerQueryValue(undefined),
    ).toBeUndefined();

    for (const raw of [
      ["true", "false"],
      "TRUE",
      "1",
      "",
      true,
    ]) {
      expect(() =>
        parseQualifiedConnectedAccountV4BooleanQueryValue(raw),
      ).toThrow();
    }
    for (const raw of [
      ["1", "2"],
      "-1",
      "01",
      "1.5",
      "",
      "9007199254740992",
      1,
    ]) {
      expect(() =>
        parseQualifiedConnectedAccountV4NonnegativeIntegerQueryValue(raw),
      ).toThrow();
    }
  });
});
