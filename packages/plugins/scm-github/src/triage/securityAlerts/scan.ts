import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, TriageSourceScanEvidenceV1Schema,
  MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1, projectTriageDisplayTextV1,
  TRIAGE_SOURCE_FAILURE_CLASSES_V1,
  TriageSourceFailureV1Schema,
  type TriageConfiguredSourceInstanceV1, type TriageScanInputV1, type TriageScanResultV1,
  type TriageSourceScanEvidenceV1 } from '@happier-dev/triage-protocol/v1';
import { deriveTriageConfiguredSourceInstanceDigestV1 } from '@happier-dev/triage-sources/runtime';
import { decodeGithubJsonResponse, type GithubApiClientV1 } from '../../observations/githubApiClient.js';
import { GITHUB_API_ORIGIN } from '../../observations/githubProviderContracts.js';
import { readGithubTriageAlertFamilies, type GithubTriageConfigurationV1 } from '../configuration.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure, isGithubSuccessStatus } from '../errors.js';
import { buildGithubApiUrl, parseGithubRoutingToken } from '../locator.js';
import { toTriageScanObservation } from '../mapping/protocol.js';
import { readGithubRepositoryDirectoryPage, type GithubRepositoryReaderV1 } from '../repositories.js';
import { GITHUB_MAX_PAGE_SIZE_V1 } from '../types.js';
import { readValidatedGithubCursorFollowUpPage, validateGithubCursorFollowUpUrl, validateGithubFollowUpPageUrl } from '../scan/link.js';
import { decodeGithubSecurityAlert, type GithubSecurityAlertKindV1 } from './contracts.js';
import { projectGithubSecurityAlert } from './mapping.js';

const text = defineProtocolString({ minLength: 1 });
const count = defineProtocolNumber({ integer: true, minimum: 0 });
const booleanValue = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const repositorySchema = defineProtocolObject({ id: text, key: text }, { policy: 'closed' });
const familyFailureSchema = defineProtocolUnion([
  defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[0]),
  defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[1]),
  ...TRIAGE_SOURCE_FAILURE_CLASSES_V1.slice(2).map(value => defineProtocolLiteral(value)),
  defineProtocolLiteral('repository-unresolved'), defineProtocolLiteral('invalid'),
  defineProtocolLiteral('cursor-invalid'), defineProtocolLiteral('undecodable'),
]);
type FamilyFailure = ReturnType<typeof familyFailureSchema.parse>;
const nativeSchema = defineProtocolObject({
  index: count,
  family: count,
  repository: repositorySchema.optional(),
  nextUrl: text.optional(),
  directoryUrl: text.optional(),
  directoryPosition: count,
  directorySize: count.optional(),
  nextDirectoryUrl: text.optional(),
  ended: booleanValue,
  dependabotFailure: familyFailureSchema.optional(),
  codeScanningFailure: familyFailureSchema.optional(),
  failure: TriageSourceFailureV1Schema.optional(),
}, { policy: 'closed' });
const continuationSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), kind: defineProtocolLiteral('github-forge-alerts'), instanceDigest: text,
  completedSinceMs: count.optional(), limit: defineProtocolNumber({ integer: true, minimum: 1 }),
  query: text.optional(),
  turn: defineProtocolUnion([defineProtocolLiteral('forge'), defineProtocolLiteral('alerts')]),
  forgeEnded: booleanValue, forge: text.optional(), native: nativeSchema,
  evidence: TriageSourceScanEvidenceV1Schema.optional(),
}, { policy: 'closed' });
type NativeFrontier = ReturnType<typeof nativeSchema.parse>;
type Frontier = ReturnType<typeof continuationSchema.parse>;

const invalid = (): Extract<TriageScanResultV1, { kind: 'failed' }> => ({ kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_alert_scan_continuation_invalid' } });
// The frontier needs the next repository, not an account inventory. Asking for
// one avoids retaining a directory body or repeatedly reading the same page.
const directoryFirst = (): string => `${GITHUB_API_ORIGIN}/user/repos?per_page=1`;
function admitsDirectory(url: string): boolean {
  return url === directoryFirst() || validateGithubFollowUpPageUrl(url, directoryFirst()) !== null;
}
function nativeFirst(kindId: GithubSecurityAlertKindV1, repositoryKey: string, limit: number): string | null {
  const route = parseGithubRoutingToken(repositoryKey);
  if (route === null) return null;
  const url = new URL(buildGithubApiUrl(['repos', route.owner, route.name,
    kindId === 'dependabot-alert' ? 'dependabot' : 'code-scanning', 'alerts']));
  url.searchParams.set('per_page', String(Math.min(limit, GITHUB_MAX_PAGE_SIZE_V1)));
  // Code scanning's omitted state means all states; Dependabot is explicit.
  if (kindId === 'dependabot-alert') url.searchParams.set('state', 'open,dismissed,fixed,auto_dismissed');
  return url.toString();
}
function sticky(evidence: TriageSourceScanEvidenceV1): TriageSourceScanEvidenceV1 | undefined {
  return evidence.kind === 'partial' && !['projection-budget', 'scope-selection', 'github-alert-paging'].includes(evidence.reason)
    ? { kind: 'partial', reason: evidence.reason, ...(evidence.failure === undefined ? {} : { failure: evidence.failure }) } : undefined;
}
function keepEvidence(previous: TriageSourceScanEvidenceV1 | undefined,
  current: TriageSourceScanEvidenceV1): TriageSourceScanEvidenceV1 | undefined {
  // The bounded native frontier combines the two families, so its newer report
  // retains both failures rather than permanently hiding the second one.
  if (current.kind === 'partial' && current.reason.startsWith('github-alerts-')) return sticky({ ...current,
    ...(previous?.kind === 'partial' && previous.failure !== undefined ? { failure: previous.failure } : {}) });
  return previous ?? sticky(current);
}

/** Alternates the established forge scanner and one native page; no new scan service. */
export async function scanGithubForgeWithAlerts(input: Readonly<{
  instance: TriageConfiguredSourceInstanceV1;
  configuration: GithubTriageConfigurationV1;
  page: TriageScanInputV1['page'];
  completedSinceMs?: number;
  query?: string;
  client: GithubApiClientV1;
  repositories: GithubRepositoryReaderV1;
  signal: AbortSignal;
  now: () => number;
  scanForge: (page: TriageScanInputV1['page']) => Promise<TriageScanResultV1>;
}>): Promise<TriageScanResultV1> {
  const settings = readGithubTriageAlertFamilies(input.configuration);
  if (!settings.dependabot && !settings.codeScanning) return await input.scanForge(input.page);
  const families: GithubSecurityAlertKindV1[] = [
    ...(settings.dependabot ? ['dependabot-alert' as const] : []),
    ...(settings.codeScanning ? ['code-scanning-alert' as const] : []),
  ];
  const instanceDigest = deriveTriageConfiguredSourceInstanceDigestV1(input.instance);
  let frontier: Frontier;
  if (input.page.kind === 'initial') frontier = { v: 1, kind: 'github-forge-alerts', instanceDigest,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.completedSinceMs === undefined ? {} : { completedSinceMs: input.completedSinceMs }),
    limit: input.page.limit, turn: 'forge', forgeEnded: false,
    native: { index: 0, family: 0, directoryPosition: 0, ended: false } };
  else {
    const parsed = continuationSchema.safeParse(decodeTriagePagingTokenV1(input.page.continuation.token));
    if (!parsed.success || parsed.data.instanceDigest !== instanceDigest
      || parsed.data.query !== input.query
      || parsed.data.completedSinceMs !== input.completedSinceMs || parsed.data.native.family >= families.length
      || parsed.data.native.directoryUrl !== undefined && !admitsDirectory(parsed.data.native.directoryUrl)
      || parsed.data.native.nextDirectoryUrl !== undefined && !admitsDirectory(parsed.data.native.nextDirectoryUrl)) return invalid();
    frontier = parsed.data;
  }
  input.signal.throwIfAborted();
  let result: TriageScanResultV1;
  if (!frontier.forgeEnded && (frontier.turn === 'forge' || frontier.native.ended)) {
    result = await input.scanForge(frontier.forge === undefined ? { kind: 'initial', limit: frontier.limit }
      : { kind: 'continuation', continuation: { v: 1, token: frontier.forge } });
    input.signal.throwIfAborted();
    if (result.kind === 'failed') {
      // One failed family must not erase other readable work.
      frontier = { ...frontier, forgeEnded: true, forge: undefined, turn: 'alerts',
        evidence: keepEvidence(frontier.evidence, { kind: 'partial', reason: `github-forge-${result.failure.class}` }) };
      result = { kind: 'complete', observations: [], evidence: { kind: 'partial', reason: `github-forge-${result.failure.class}` } };
    } else frontier = { ...frontier, forgeEnded: result.kind === 'complete',
      forge: result.kind === 'page' ? result.continuation.token : undefined, turn: 'alerts',
      evidence: keepEvidence(frontier.evidence, result.evidence) };
  } else {
    const native = await scanNativePage(input, frontier.native, families, frontier.limit);
    if (native.kind === 'failed') return native;
    result = native.result;
    frontier = { ...frontier, native: native.frontier, turn: 'forge', evidence: keepEvidence(frontier.evidence, result.evidence) };
  }
  const evidence = frontier.evidence ?? result.evidence;
  const observations = result.observations;
  if (frontier.forgeEnded && frontier.native.ended) return { kind: 'complete', observations,
    evidence: frontier.evidence ?? { kind: 'walkFinished' } };
  const token = encodeTriagePagingTokenV1(frontier);
  if (token === null) return { kind: 'complete', observations, evidence: { kind: 'partial', reason: 'continuation-unavailable' } };
  return { kind: 'page', observations, evidence: evidence.kind === 'walkFinished' ? { kind: 'partial', reason: 'github-alert-paging' } : evidence,
    continuation: { v: 1, token } };
}

type NativePage = Readonly<{ kind: 'scanned'; frontier: NativeFrontier;
  result: Exclude<TriageScanResultV1, { kind: 'failed' }> }> | Extract<TriageScanResultV1, { kind: 'failed' }>;

async function scanNativePage(input: Parameters<typeof scanGithubForgeWithAlerts>[0], initial: NativeFrontier,
  families: readonly GithubSecurityAlertKindV1[], limit: number): Promise<NativePage> {
  let frontier = initial;
  let directoryIncomplete = false;
  // The directory row read in THIS invocation, with this credential, already proves the
  // route→id mapping; only a repository carried in from a continuation is re-proven.
  let listedHere: Extract<Awaited<ReturnType<GithubRepositoryReaderV1['read']>>, { kind: 'readable' }> | null = null;
  const finish = (reason?: string, observations: Exclude<TriageScanResultV1, { kind: 'failed' }>['observations'] = [], omittedItemCount = 0): NativePage => ({
    kind: 'scanned', frontier, result: { kind: 'complete', observations,
      evidence: reason === undefined ? { kind: 'walkFinished' } : { kind: 'partial', reason,
        ...(frontier.failure === undefined ? {} : { failure: frontier.failure }),
        ...(omittedItemCount === 0 ? {} : { omittedItemCount }) } },
  });
  const advanceFamily = () => {
    const nextFamily = frontier.family + 1;
    frontier = nextFamily < families.length ? { ...frontier, family: nextFamily, nextUrl: undefined }
      : { ...frontier, family: 0, nextUrl: undefined, repository: undefined, index: frontier.index + 1,
        directoryPosition: frontier.directoryPosition + 1 };
  };
  if (frontier.repository === undefined) {
    if (input.configuration.selection.kind === 'selected') {
      const key = input.configuration.selection.unitIds[frontier.index];
      if (key === undefined) { frontier = { ...frontier, ended: true }; return finish(); }
      const route = parseGithubRoutingToken(key);
      if (route === null) return invalid();
      const repository = await input.repositories.read(route);
      input.signal.throwIfAborted();
      if (repository.kind !== 'readable' || repository.repositoryKey === null) {
        frontier = { ...frontier, index: frontier.index + 1 };
        return finish(`github-alert-repository-${repository.kind === 'unreadable' ? repository.failure.class : 'unknown'}`);
      }
      frontier = { ...frontier, repository: { id: repository.repositoryId, key } };
    } else {
      if (frontier.directorySize !== undefined && frontier.directoryPosition >= frontier.directorySize) {
        if (frontier.nextDirectoryUrl === undefined) { frontier = { ...frontier, ended: true }; return finish(); }
        frontier = { ...frontier, directoryUrl: frontier.nextDirectoryUrl, directoryPosition: 0, directorySize: undefined, nextDirectoryUrl: undefined };
      }
      const url = frontier.directoryUrl ?? directoryFirst();
      const page = await readGithubRepositoryDirectoryPage({ client: input.client, url, now: input.now });
      input.signal.throwIfAborted();
      if (page.kind === 'failed') { frontier = { ...frontier, ended: true }; return finish(`github-alert-repositories-${page.failure.class}`); }
      const repository = page.repositories[frontier.directoryPosition];
      directoryIncomplete = page.partial;
      frontier = { ...frontier, directoryUrl: url, directorySize: page.repositories.length,
        nextDirectoryUrl: page.nextUrl ?? undefined };
      if (repository === undefined || repository.repositoryKey === null) {
        return finish(page.partial ? 'github-alert-repositories-incomplete' : undefined);
      }
      frontier = { ...frontier, repository: { id: repository.repositoryId, key: repository.repositoryKey } };
      listedHere = repository;
    }
  }
  const repository = frontier.repository;
  const kindId = families[frontier.family];
  if (repository === undefined || kindId === undefined) return invalid();
  const recordFailure = (failure: FamilyFailure, typedFailure?: ReturnType<typeof TriageSourceFailureV1Schema.parse>): string => {
    const family = kindId === 'dependabot-alert' ? 'Dependabot' : 'Code scanning';
    const readFailure = typedFailure?.class === 'permission' ? { ...typedFailure,
      detail: projectTriageDisplayTextV1([
        typedFailure.detail,
        `${family} alerts could not be read. Reconnect this GitHub account with ${family} alerts read access (classic tokens: security_events), then refresh.`,
      ].filter(value => value !== undefined).join(' '), MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1).value } : typedFailure;
    frontier = { ...frontier, ...(kindId === 'dependabot-alert' ? { dependabotFailure: failure } : { codeScanningFailure: failure }),
      ...(frontier.failure !== undefined || readFailure === undefined ? {} : { failure: readFailure }) };
    return `github-alerts-${[
      ...(frontier.dependabotFailure === undefined ? [] : [`dependabot-${frontier.dependabotFailure}`]),
      ...(frontier.codeScanningFailure === undefined ? [] : [`code-scanning-${frontier.codeScanningFailure}`]),
    ].join('-')}`;
  };
  if (input.configuration.selection.kind === 'selected' && repository.key !== input.configuration.selection.unitIds[frontier.index]) return invalid();
  const route = parseGithubRoutingToken(repository.key);
  if (route === null) return invalid();
  // A caller-owned continuation cannot provide repository identity proof.
  const admitted = listedHere ?? await input.repositories.read(route);
  input.signal.throwIfAborted();
  if (admitted.kind !== 'readable' || admitted.repositoryId !== repository.id) {
    const reason = recordFailure('repository-unresolved'); advanceFamily(); return finish(reason);
  }
  const first = nativeFirst(kindId, repository.key, limit);
  if (first === null) return invalid();
  const url = frontier.nextUrl ?? first;
  if (url !== first && validateGithubCursorFollowUpUrl(url, first, repository.id) === null) return invalid();
  let response;
  try { response = await input.client.request({ url }); }
  catch (error) { input.signal.throwIfAborted(); const failure = classifyGithubTransportFailure(error); const reason = recordFailure(failure.class, failure);
    advanceFamily(); return finish(reason); }
  input.signal.throwIfAborted();
  if (!isGithubSuccessStatus(response.status)) {
    const failure = classifyGithubResponseFailure(response, input.now());
    const reason = recordFailure(failure.class, failure); advanceFamily(); return finish(reason);
  }
  let rows: unknown;
  try { rows = decodeGithubJsonResponse(response); }
  catch { const reason = recordFailure('invalid'); advanceFamily(); return finish(reason); }
  if (!Array.isArray(rows) || rows.length > Math.min(limit, GITHUB_MAX_PAGE_SIZE_V1)) {
    const reason = recordFailure('invalid'); advanceFamily(); return finish(reason);
  }
  const observations = rows.flatMap(row => {
    const alert = decodeGithubSecurityAlert(kindId, row);
    const mapped = alert === null ? null : projectGithubSecurityAlert({ alert, repositoryId: repository.id,
      repositoryKey: admitted.repositoryKey ?? repository.key });
    return mapped === null ? [] : [toTriageScanObservation(mapped)];
  });
  const next = readValidatedGithubCursorFollowUpPage(response.headers, url, repository.id);
  if (next.kind === 'next') frontier = { ...frontier, nextUrl: next.url };
  else advanceFamily();
  return finish(next.kind === 'invalid' ? recordFailure('cursor-invalid')
    : observations.length !== rows.length ? recordFailure('undecodable')
      : directoryIncomplete ? 'github-alert-repositories-incomplete' : undefined, observations, rows.length - observations.length);
}
