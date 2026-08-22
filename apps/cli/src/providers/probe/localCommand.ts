import {
  PROVIDER_CATALOG_LIMITS_V1,
  ProviderCatalogCommandFallbackV1Schema,
  ProviderEndpointUrlSyntaxSchema,
  ProviderModelDescriptorV1Schema,
  readBundledProviderCommandCatalogParserFactV1,
  type BundledProviderCommandCatalogParserV1,
  type ProviderCatalogCommandFallbackV1,
  type ProviderCommandCatalogParserV1,
  type ProviderModelDescriptorV1,
} from '@happier-dev/protocol';

import type { ProviderCatalogFormatParser } from './parsers';

const LITERAL_TOKEN = /^[^\u0000-\u001f\u007f;&|`$<>]+$/u;
const LOCAL_CATALOG_COMMAND_MAX_BYTES = 1024 * 1024;
const LOCAL_CATALOG_COMMAND_TTL_MS = 30_000;

export type ProviderLocalCommandRunner = Readonly<{
  runSystemTool(input: Readonly<{
    toolId: string;
    lookupNames: readonly string[];
    args: readonly string[];
    env?: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    reason: string;
  }>): Promise<
    | Readonly<{ ok: true; exitCode: number | null; stdout: string; stderr: string }>
    | Readonly<{ ok: false; reasonCode: string }>
  >;
}>;

export type ProviderLocalToolResolver = Readonly<{
  resolveSystemTool(input: Readonly<{
    toolId: string;
    lookupNames: readonly string[];
    reason: string;
  }>): Promise<Readonly<{ ok: true; command: string; args: readonly string[]; source: string }> | Readonly<{ ok: false; reasonCode: string }>>;
}>;

export async function resolveDeclaredProviderInstallation(
  descriptor: Readonly<{ toolId: string; lookupNames: readonly string[] }>,
  resolver: ProviderLocalToolResolver,
): Promise<Readonly<{ status: 'present' | 'absent' }>> {
  if (!descriptor.toolId || descriptor.lookupNames.length === 0
    || descriptor.lookupNames.some((name) => !LITERAL_TOKEN.test(name) || name.includes('/') || name.includes('\\'))) {
    throw new TypeError('Provider local installation checks require bounded lookup names');
  }
  const result = await resolver.resolveSystemTool({
    toolId: descriptor.toolId,
    lookupNames: [...descriptor.lookupNames],
    reason: 'provider local installation check',
  });
  return { status: result.ok ? 'present' : 'absent' };
}

export type ProviderLocalCatalogFallbackResult =
  | Readonly<{ status: 'success'; models: readonly ProviderModelDescriptorV1[] }>
  | Readonly<{ status: 'unavailable' }>;

function commandStdout(input: unknown): string {
  if (typeof input !== 'string') throw new TypeError('Provider command catalog output must be text');
  if (Buffer.byteLength(input, 'utf8') > LOCAL_CATALOG_COMMAND_MAX_BYTES) {
    throw new TypeError('Provider command catalog output exceeds the response limit');
  }
  return input;
}

const parseOllamaListTable: ProviderCatalogFormatParser = (input) => {
  const lines = commandStdout(input).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new TypeError('Ollama model table is empty');
  const header = lines[0]!.split(/\s+/u).map((part) => part.toUpperCase());
  if (header.length !== 4 || header.join('\0') !== 'NAME\0ID\0SIZE\0MODIFIED') {
    throw new TypeError('Ollama model table header is unrecognized');
  }
  return {
    models: lines.slice(1).map((line) => {
      const columns = line.split(/\s+/u);
      if (columns.length < 4) throw new TypeError('Ollama model table row is malformed');
      return { id: columns[0]! };
    }),
  };
};

/**
 * The command-output catalog formats the host implements. A Provider plugin
 * contributes any other format through the `providers` contribution family and
 * implements it with the same registered catalog parser used for HTTP catalog
 * formats; the bundled set never decides whether a declared format is valid.
 */
export const BUNDLED_PROVIDER_COMMAND_CATALOG_FORMAT_PARSERS: Readonly<
  Record<BundledProviderCommandCatalogParserV1, ProviderCatalogFormatParser>
> = Object.freeze({ 'ollama-list-table': parseOllamaListTable });

/**
 * Resolves a declared command-output format to its implementation. A
 * contributed parser wins only for a format the host does not bundle, so a
 * plugin can never displace a bundled format's meaning for another Provider.
 */
export function resolveProviderCommandCatalogFormatParser(
  parser: ProviderCommandCatalogParserV1,
  contributedParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>,
): ProviderCatalogFormatParser | null {
  const bundled = readBundledProviderCommandCatalogParserFactV1(
    BUNDLED_PROVIDER_COMMAND_CATALOG_FORMAT_PARSERS,
    parser,
  );
  if (bundled) return bundled;
  const contributed = contributedParsers
    ? Object.getOwnPropertyDescriptor(contributedParsers, parser)
    : undefined;
  return contributed && contributed.enumerable && typeof contributed.value === 'function'
    ? contributed.value as ProviderCatalogFormatParser
    : null;
}

/**
 * Host-owned normalization of any command format's output. A contributed format
 * decides the model rows; the descriptor schema, dedupe, and size limits stay
 * here so a plugin cannot widen them. An unresolvable or unparseable format
 * reports `unavailable` exactly as a failed command does — the fallback never
 * hands the output to another format's parser.
 */
function runCommandCatalogFormat(
  parser: ProviderCommandCatalogParserV1,
  stdout: string,
  contributedParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>,
): ProviderLocalCatalogFallbackResult {
  const parse = resolveProviderCommandCatalogFormatParser(parser, contributedParsers);
  if (!parse) return { status: 'unavailable' };
  let rows: ReturnType<ProviderCatalogFormatParser>;
  try {
    rows = parse(stdout);
  } catch {
    return { status: 'unavailable' };
  }
  if (!Array.isArray(rows.models)) return { status: 'unavailable' };
  if (rows.models.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection) {
    return { status: 'unavailable' };
  }
  const models: ProviderModelDescriptorV1[] = [];
  const ids = new Set<string>();
  for (const row of rows.models) {
    const parsed = ProviderModelDescriptorV1Schema.safeParse({ ...row, name: row.name ?? row.id });
    if (!parsed.success || ids.has(parsed.data.id)) return { status: 'unavailable' };
    ids.add(parsed.data.id);
    models.push(parsed.data);
  }
  return { status: 'success', models: Object.freeze(models) };
}

/**
 * Bounded, contribution-declared command fallback used only by the authorized
 * provider catalog service after HTTP probes fail. It is intentionally not an
 * inventory or endpoint-health primitive.
 */
export function createProviderLocalCatalogFallbackRunner(input: Readonly<{
  runner: ProviderLocalCommandRunner;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}>) {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? LOCAL_CATALOG_COMMAND_TTL_MS;
  const maxEntries = input.maxEntries ?? 128;
  if (!Number.isInteger(ttlMs) || ttlMs < LOCAL_CATALOG_COMMAND_TTL_MS || ttlMs > 10 * 60_000) {
    throw new TypeError('Provider local catalog fallback TTL must be between 30 seconds and 10 minutes');
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 512) {
    throw new TypeError('Provider local catalog fallback cache limit must be between 1 and 512');
  }
  const inFlight = new Map<string, Promise<ProviderLocalCatalogFallbackResult>>();
  const completed = new Map<string, Readonly<{ expiresAt: number; result: ProviderLocalCatalogFallbackResult }>>();

  const run = async (raw: Readonly<{
    descriptor: ProviderCatalogCommandFallbackV1;
    endpointUrl: string;
    /**
     * Implementations of the command-output formats the declaring Provider
     * plugin contributes, keyed by format id. A format the host bundles is
     * never taken from here.
     */
    contributedCatalogParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>;
  }>): Promise<ProviderLocalCatalogFallbackResult> => {
    const descriptor = ProviderCatalogCommandFallbackV1Schema.parse(raw.descriptor);
    const endpointUrl = ProviderEndpointUrlSyntaxSchema.parse(raw.endpointUrl);
    const key = JSON.stringify([descriptor, endpointUrl]);
    const active = inFlight.get(key);
    if (active) return active;
    const cached = completed.get(key);
    if (cached && now() < cached.expiresAt) return cached.result;

    const operation = (async (): Promise<ProviderLocalCatalogFallbackResult> => {
      const result = await input.runner.runSystemTool({
        toolId: `provider-catalog-fallback:${descriptor.endpointTemplateId}`,
        lookupNames: [...descriptor.lookupNames],
        args: [...descriptor.fixedArgs],
        ...(descriptor.endpointEnvName ? { env: { [descriptor.endpointEnvName]: endpointUrl } } : {}),
        timeoutMs: 5_000,
        maxStdoutBytes: LOCAL_CATALOG_COMMAND_MAX_BYTES + 1,
        maxStderrBytes: 16 * 1024,
        reason: 'provider local catalog fallback',
      });
      if (!result.ok || result.exitCode !== 0) return { status: 'unavailable' };
      return runCommandCatalogFormat(descriptor.parser, result.stdout, raw.contributedCatalogParsers);
    })();
    inFlight.set(key, operation);
    try {
      const result = await operation;
      const currentTime = now();
      for (const [entryKey, entry] of completed) {
        if (currentTime >= entry.expiresAt) completed.delete(entryKey);
      }
      while (completed.size >= maxEntries) {
        const oldest = completed.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        completed.delete(oldest);
      }
      completed.set(key, { expiresAt: currentTime + ttlMs, result });
      return result;
    } finally {
      inFlight.delete(key);
    }
  };

  return { run };
}

export async function runDeclaredProviderLocalCommand(
  descriptor: Readonly<{
    toolId: string;
    lookupNames: readonly string[];
    fixedArgs: readonly string[];
    parser: 'exit-zero-running' | 'lms-status-json';
  }>,
  runner: ProviderLocalCommandRunner,
): Promise<Readonly<{ status: 'present' | 'absent' }>> {
  if (!descriptor.toolId || descriptor.lookupNames.length === 0
    || descriptor.lookupNames.some((name) => !LITERAL_TOKEN.test(name) || name.includes('/') || name.includes('\\'))
    || descriptor.fixedArgs.some((arg) => !LITERAL_TOKEN.test(arg))) {
    throw new TypeError('Provider local commands require bounded literal tokens');
  }
  const result = await runner.runSystemTool({
    toolId: descriptor.toolId,
    lookupNames: [...descriptor.lookupNames],
    args: [...descriptor.fixedArgs],
    timeoutMs: 5_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 16 * 1024,
    reason: 'provider local presence check',
  });
  if (!result.ok) return { status: 'absent' };
  if (descriptor.parser === 'exit-zero-running') {
    return { status: result.exitCode === 0 ? 'present' : 'absent' };
  }
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, 'utf8') > 64 * 1024) return { status: 'absent' };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 'absent' };
    const descriptor = Object.getOwnPropertyDescriptor(parsed, 'status');
    return { status: descriptor && 'value' in descriptor && descriptor.value === 'running' ? 'present' : 'absent' };
  } catch {
    return { status: 'absent' };
  }
}
