import { ClientCompatibilityDeclarationV1Schema, type ClientCompatibilityDeclarationV1 } from './clientDeclarationV1.js';

export const CLIENT_COMPATIBILITY_HTTP_HEADERS_V1 = Object.freeze({
  clientKind: 'x-happier-client-kind',
  appVersion: 'x-happier-client-version',
  releaseChannel: 'x-happier-client-release-channel',
  sessionSyncProtocolVersion: 'x-happier-session-sync-protocol',
} as const);

type ClientCompatibilityHttpHeaderName = typeof CLIENT_COMPATIBILITY_HTTP_HEADERS_V1[
  keyof typeof CLIENT_COMPATIBILITY_HTTP_HEADERS_V1
];

type RequiredClientCompatibilityHttpHeaderName = Exclude<
  ClientCompatibilityHttpHeaderName,
  typeof CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.releaseChannel
>;

export type ClientCompatibilityHttpHeadersV1 = Readonly<
  Record<RequiredClientCompatibilityHttpHeaderName, string>
  & Partial<Record<typeof CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.releaseChannel, string>>
>;

export type ClientCompatibilityDeclarationParseResult =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'malformed' }>
  | Readonly<{ status: 'valid'; declaration: ClientCompatibilityDeclarationV1 }>;

const RELEVANT_HEADER_NAMES = new Set<string>(Object.values(CLIENT_COMPATIBILITY_HTTP_HEADERS_V1));

export function buildClientCompatibilityHttpHeadersV1(input: ClientCompatibilityDeclarationV1): ClientCompatibilityHttpHeadersV1 {
  const declaration = ClientCompatibilityDeclarationV1Schema.parse(input);
  return {
    [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.clientKind]: declaration.clientKind,
    [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.appVersion]: declaration.appVersion,
    ...(declaration.releaseChannel
      ? { [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.releaseChannel]: declaration.releaseChannel }
      : {}),
    [CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.sessionSyncProtocolVersion]: String(declaration.sessionSyncProtocolVersion),
  };
}

export function parseClientCompatibilityHttpHeadersV1(
  input: Readonly<Record<string, unknown>>,
): ClientCompatibilityDeclarationParseResult {
  const values = new Map<ClientCompatibilityHttpHeaderName, string>();
  let relevantHeaderCount = 0;

  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (!RELEVANT_HEADER_NAMES.has(name)) continue;
    relevantHeaderCount += 1;

    const canonicalName = name as ClientCompatibilityHttpHeaderName;
    if (values.has(canonicalName) || typeof rawValue !== 'string' || rawValue.includes(',')) {
      return { status: 'malformed' };
    }
    values.set(canonicalName, rawValue);
  }

  if (relevantHeaderCount === 0) return { status: 'missing' };

  const clientKind = values.get(CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.clientKind);
  const appVersion = values.get(CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.appVersion);
  const releaseChannel = values.get(CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.releaseChannel);
  const protocolText = values.get(CLIENT_COMPATIBILITY_HTTP_HEADERS_V1.sessionSyncProtocolVersion);
  if (clientKind === undefined || appVersion === undefined || protocolText === undefined) {
    return { status: 'malformed' };
  }
  if (!/^[1-9][0-9]*$/.test(protocolText)) return { status: 'malformed' };

  const parsed = ClientCompatibilityDeclarationV1Schema.safeParse({
    v: 1,
    clientKind,
    appVersion,
    ...(releaseChannel === undefined ? {} : { releaseChannel }),
    sessionSyncProtocolVersion: Number(protocolText),
  });
  return parsed.success
    ? { status: 'valid', declaration: parsed.data }
    : { status: 'malformed' };
}
