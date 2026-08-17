import { z } from 'zod';

export const ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V1 = 1 as const;
export const ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2 = 2 as const;
export const ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V3 = 3 as const;
export const ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V4 = 4 as const;
/** V5 is reserved solely for the Account-owned staged encryption transition. */
export const ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V5 = 5 as const;
export const CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION =
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V3;

/**
 * Plugin-domain AccountChange rows were added in V3. V2 peers retain the
 * incumbent stored-content contract while the change-feed owner filters this
 * new kind from their pages; V3 is the canonical current declaration.
 */
export const ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION =
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V3;

/**
 * V4 adds the additive Session-access witness to `/v2/changes`. V3 clients
 * parse that response strictly, so a V3 declaration must retain the exact
 * incumbent page shape.
 */
export const ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION =
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V4;

/**
 * This must be checked by the transition operation itself. It is not the base
 * stored-content requirement and is deliberately not advertised by default.
 */
export const ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION =
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V5;

/**
 * The caller advertises its optional response-field support independently of
 * the protocol version it requires from a server. An older V3 server remains
 * usable; it simply omits the V4 witness and Session-scoped Resources fail
 * closed at their owner.
 */
export const CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION =
  ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION;

export const AccountStoredContentProtocolVersionSchema = z
  .number()
  .int()
  .min(ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V1)
  .max(Number.MAX_SAFE_INTEGER);

export const AccountStoredContentCompatibilityDeclarationV1Schema = z
  .object({
    v: z.literal(1),
    protocolVersion: AccountStoredContentProtocolVersionSchema,
  })
  .strict();

export type AccountStoredContentCompatibilityDeclarationV1 = z.infer<
  typeof AccountStoredContentCompatibilityDeclarationV1Schema
>;

export const CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION =
  Object.freeze({
    v: 1,
    protocolVersion:
      CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION,
  } satisfies AccountStoredContentCompatibilityDeclarationV1);

export const PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION =
  Object.freeze({
    v: 1,
    protocolVersion: ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
  } satisfies AccountStoredContentCompatibilityDeclarationV1);

export type AccountStoredContentCompatibilityDeclarationParseResult =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'malformed' }>
  | Readonly<{
      status: 'valid';
      declaration: AccountStoredContentCompatibilityDeclarationV1;
    }>;

export const ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER =
  'x-happier-account-stored-content-protocol' as const;

export type AccountStoredContentCompatibilityHttpHeadersV1 = Readonly<
  Record<typeof ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER, string>
>;

export function buildAccountStoredContentCompatibilityHttpHeadersV1(
  input: AccountStoredContentCompatibilityDeclarationV1,
): AccountStoredContentCompatibilityHttpHeadersV1 {
  const declaration = AccountStoredContentCompatibilityDeclarationV1Schema.parse(input);
  return {
    [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: String(
      declaration.protocolVersion,
    ),
  };
}

export function parseAccountStoredContentCompatibilityHttpHeadersV1(
  input: Readonly<Record<string, unknown>>,
): AccountStoredContentCompatibilityDeclarationParseResult {
  const values: unknown[] = [];
  for (const [rawName, rawValue] of Object.entries(input)) {
    if (
      rawName.toLowerCase()
      === ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER
    ) {
      values.push(rawValue);
    }
  }
  if (values.length === 0) return { status: 'missing' };
  if (
    values.length !== 1
    || typeof values[0] !== 'string'
    || values[0].includes(',')
    || !/^[1-9][0-9]*$/.test(values[0])
  ) {
    return { status: 'malformed' };
  }
  const parsed = AccountStoredContentCompatibilityDeclarationV1Schema.safeParse({
    v: 1,
    protocolVersion: Number(values[0]),
  });
  return parsed.success
    ? { status: 'valid', declaration: parsed.data }
    : { status: 'malformed' };
}

export const AccountStoredContentCompatibilitySocketAuthV1Schema = z
  .object({
    accountStoredContentCompatibility:
      AccountStoredContentCompatibilityDeclarationV1Schema,
  })
  .passthrough();

export type AccountStoredContentCompatibilitySocketAuthV1 = Readonly<{
  accountStoredContentCompatibility:
    AccountStoredContentCompatibilityDeclarationV1;
}>;

export function buildAccountStoredContentCompatibilitySocketAuthV1(
  input: AccountStoredContentCompatibilityDeclarationV1,
): AccountStoredContentCompatibilitySocketAuthV1 {
  return {
    accountStoredContentCompatibility:
      AccountStoredContentCompatibilityDeclarationV1Schema.parse(input),
  };
}

export function parseAccountStoredContentCompatibilitySocketAuthV1(
  input: unknown,
): AccountStoredContentCompatibilityDeclarationParseResult {
  if (
    typeof input !== 'object'
    || input === null
    || !Object.prototype.hasOwnProperty.call(
      input,
      'accountStoredContentCompatibility',
    )
  ) {
    return { status: 'missing' };
  }
  const parsed =
    AccountStoredContentCompatibilitySocketAuthV1Schema.safeParse(input);
  return parsed.success
    ? {
        status: 'valid',
        declaration: parsed.data.accountStoredContentCompatibility,
      }
    : { status: 'malformed' };
}

export const AccountStoredContentCompatibilityServerRequirementsV1Schema = z
  .object({
    v: z.literal(1),
    minimumProtocolVersion: AccountStoredContentProtocolVersionSchema,
    currentProtocolVersion: AccountStoredContentProtocolVersionSchema,
    declarationTransport: z.literal('http-header-and-socket-auth-v1'),
  })
  .strict();

export type AccountStoredContentCompatibilityServerRequirementsV1 = z.infer<
  typeof AccountStoredContentCompatibilityServerRequirementsV1Schema
>;

export const AccountStoredContentServerCompatibilityDecisionSchema = z.enum([
  'missing',
  'malformed',
  'server-too-old',
  'client-too-old',
  'compatible',
]);

export type AccountStoredContentServerCompatibilityDecision = z.infer<
  typeof AccountStoredContentServerCompatibilityDecisionSchema
>;

export function classifyCurrentAccountStoredContentServerCompatibility(
  input: unknown,
): AccountStoredContentServerCompatibilityDecision {
  if (input === undefined || input === null) return 'missing';
  const parsed =
    AccountStoredContentCompatibilityServerRequirementsV1Schema.safeParse(input);
  if (!parsed.success) return 'malformed';
  if (
    parsed.data.currentProtocolVersion
    < CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION
  ) {
    return 'server-too-old';
  }
  if (
    parsed.data.minimumProtocolVersion
    > CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION
  ) {
    return 'client-too-old';
  }
  return 'compatible';
}

/**
 * Classifies only the staged Account encryption transition. General V3 Plugin
 * Data compatibility remains usable against servers that do not implement V5.
 */
export function classifyAccountEncryptionMigrateTransitionServerCompatibility(
  input: unknown,
): AccountStoredContentServerCompatibilityDecision {
  if (input === undefined || input === null) return 'missing';
  const parsed =
    AccountStoredContentCompatibilityServerRequirementsV1Schema.safeParse(input);
  if (!parsed.success) return 'malformed';
  if (
    parsed.data.currentProtocolVersion
    < ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION
  ) {
    return 'server-too-old';
  }
  if (
    parsed.data.minimumProtocolVersion
    > ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION
  ) {
    return 'client-too-old';
  }
  return 'compatible';
}
