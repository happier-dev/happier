type StructuredQueryValueParser<T> = Readonly<{
  parse(value: unknown): T;
}>;

export const QUALIFIED_CONNECTED_ACCOUNT_V4_STRUCTURED_QUERY_MAX_LENGTH =
  16_384;

function readSingleQueryString(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error(
      "Qualified Connected Account query fields must occur exactly once",
    );
  }
  return raw;
}

export function encodeQualifiedConnectedAccountV4StructuredQueryValue<T>(
  schema: StructuredQueryValueParser<T>,
  value: unknown,
): string {
  const encoded = JSON.stringify(schema.parse(value));
  if (
    encoded.length > QUALIFIED_CONNECTED_ACCOUNT_V4_STRUCTURED_QUERY_MAX_LENGTH
  ) {
    throw new Error(
      "Qualified Connected Account structured query field is too large",
    );
  }
  return encoded;
}

export function parseQualifiedConnectedAccountV4StructuredQueryValue<T>(
  schema: StructuredQueryValueParser<T>,
  raw: unknown,
): T {
  const encoded = readSingleQueryString(raw);
  if (
    encoded.length === 0
    || encoded.length
      > QUALIFIED_CONNECTED_ACCOUNT_V4_STRUCTURED_QUERY_MAX_LENGTH
  ) {
    throw new Error(
      "Qualified Connected Account structured query field is invalid",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch (error) {
    throw new Error(
      "Qualified Connected Account structured query field is malformed",
      { cause: error },
    );
  }
  if (
    decoded === null
    || typeof decoded !== "object"
    || Array.isArray(decoded)
  ) {
    throw new Error(
      "Qualified Connected Account structured query field must be a record",
    );
  }
  return schema.parse(decoded);
}

export function parseQualifiedConnectedAccountV4BooleanQueryValue(
  raw: unknown,
): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = readSingleQueryString(raw);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    "Qualified Connected Account boolean query field is malformed",
  );
}

export function parseQualifiedConnectedAccountV4NonnegativeIntegerQueryValue(
  raw: unknown,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = readSingleQueryString(raw);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      "Qualified Connected Account integer query field is malformed",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      "Qualified Connected Account integer query field is out of range",
    );
  }
  return parsed;
}
