import { ProviderCatalogCommandFallbackV1Schema } from '@happier-dev/protocol/providers/detection/descriptorV1';
import { ProviderEndpointUrlSyntaxSchema } from '@happier-dev/protocol/providers/endpoint-url';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderCatalogCommandFallbackV1, ProviderCommandCatalogParserV1, ProviderModelDescriptorV1 } from '@happier-dev/protocol';

import type { ProviderCatalogFormatParser } from './parsers';
import { awaitAbortableWithinProviderOperation, awaitWithinProviderOperation, createProviderOperationLifetime,
  providerOperationRemainingMs, type ProviderOperationLifetime } from '../operationLifetime';

const LITERAL_TOKEN = /^[^\u0000-\u001f\u007f]+$/u;

export type ProviderLocalCommandRunner = Readonly<{
  runSystemTool(input: Readonly<{
    toolId: string;
    lookupNames: readonly string[];
    args: readonly string[];
    env?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
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
  | Readonly<{ status: 'unavailable'; error?: ProviderErrorV1 }>;

function commandStdout(input: unknown): string {
  if (typeof input !== 'string') throw new TypeError('Provider command catalog output must be text');
  return input;
}

/** Resolve the implementation supplied by the declaring Provider. */
export function resolveProviderCommandCatalogFormatParser(
  parser: ProviderCommandCatalogParserV1,
  contributedParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>,
): ProviderCatalogFormatParser | null {
  const contributed = contributedParsers
    ? Object.getOwnPropertyDescriptor(contributedParsers, parser)
    : undefined;
  return contributed && contributed.enumerable && typeof contributed.value === 'function'
    ? contributed.value as ProviderCatalogFormatParser
    : null;
}

/**
 * Host-owned normalization of any command format's output. A contributed format
 * decides the model rows; descriptor validation and dedupe stay here.
 * An unresolvable or unparseable format
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
    rows = parse(commandStdout(stdout));
  } catch (error) {
    return { status: 'unavailable', error: createProviderErrorV1('provider_probe_response_invalid', {
      failureCause: projectActionFailureCauseV1(error, 'providers.catalog.parse_command'),
    }) };
  }
  if (!Array.isArray(rows.models)) return { status: 'unavailable' };
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
 * Contribution-declared command fallback used only by the authorized
 * provider catalog service after HTTP probes fail. It is intentionally not an
 * inventory or endpoint-health primitive.
 */
export function createProviderLocalCatalogFallbackRunner(input: Readonly<{
  runner: ProviderLocalCommandRunner;
}>) {
  const run = async (raw: Readonly<{
    descriptor: ProviderCatalogCommandFallbackV1;
    endpointUrl: string;
    /**
     * Implementations of the command-output formats the declaring Provider
     * plugin contributes, keyed by format id.
     */
    contributedCatalogParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>;
    lifetime?: ProviderOperationLifetime;
  }>): Promise<ProviderLocalCatalogFallbackResult> => {
    const descriptor = ProviderCatalogCommandFallbackV1Schema.parse(raw.descriptor);
    const endpointUrl = ProviderEndpointUrlSyntaxSchema.parse(raw.endpointUrl);
    // The enclosing catalog scheduler owns freshness and single-flight work.
    const lifetime = raw.lifetime ?? createProviderOperationLifetime({});
    // Fallback is one phase of catalog refresh. It consumes the caller's
    // remaining budget and cannot start after that operation was abandoned.
    await awaitWithinProviderOperation(Promise.resolve(), lifetime);
    const result = await awaitAbortableWithinProviderOperation(signal => input.runner.runSystemTool({
      toolId: `provider-catalog-fallback:${descriptor.endpointTemplateId}`,
      lookupNames: [...descriptor.lookupNames],
      args: [...descriptor.fixedArgs],
      ...(descriptor.endpointEnvName ? { env: { [descriptor.endpointEnvName]: endpointUrl } } : {}),
      ...(Number.isFinite(lifetime.wallDeadlineAtMs)
        ? { timeoutMs: providerOperationRemainingMs(lifetime) } : {}),
      signal,
      reason: 'provider local catalog fallback',
    }), lifetime);
    if (!result.ok || result.exitCode !== 0) return { status: 'unavailable' };
    return runCommandCatalogFormat(descriptor.parser, result.stdout, raw.contributedCatalogParsers);
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
  lifetime: ProviderOperationLifetime = createProviderOperationLifetime({}),
): Promise<Readonly<{ status: 'present' | 'absent' }>> {
  if (!descriptor.toolId || descriptor.lookupNames.length === 0
    || descriptor.lookupNames.some((name) => !LITERAL_TOKEN.test(name) || name.includes('/') || name.includes('\\'))
    || descriptor.fixedArgs.some((arg) => !LITERAL_TOKEN.test(arg))) {
    throw new TypeError('Provider local commands require bounded literal tokens');
  }
  const result = await awaitAbortableWithinProviderOperation(signal => runner.runSystemTool({
    toolId: descriptor.toolId,
    lookupNames: [...descriptor.lookupNames],
    args: [...descriptor.fixedArgs],
    signal,
    ...(Number.isFinite(lifetime.wallDeadlineAtMs) ? { timeoutMs: providerOperationRemainingMs(lifetime) } : {}),
    reason: 'provider local presence check',
  }), lifetime);
  if (!result.ok) return { status: 'absent' };
  if (descriptor.parser === 'exit-zero-running') {
    return { status: result.exitCode === 0 ? 'present' : 'absent' };
  }
  if (result.exitCode !== 0) return { status: 'absent' };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 'absent' };
    const descriptor = Object.getOwnPropertyDescriptor(parsed, 'status');
    return { status: descriptor && 'value' in descriptor && descriptor.value === 'running' ? 'present' : 'absent' };
  } catch {
    return { status: 'absent' };
  }
}
