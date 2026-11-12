import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubChecksBatchReadV1 } from '../triage/checksCondition.js';
import type { GithubApiClientV1, GithubApiResponseV1 } from './githubApiClient.js';

type Representation = Readonly<{ etag: string; response: GithubApiResponseV1 }>;
export type GithubConditionalChecksEntry = Readonly<{ witnesses: readonly string[]; value: GithubChecksBatchReadV1 }>;
type ConditionalState = { representations: Map<string, Representation>; checks: Map<string, GithubConditionalChecksEntry> };
const statesByLifetime = new WeakMap<object, ConditionalState>();
const cyclesByClient = new WeakMap<GithubApiClientV1, { state: ConditionalState; acquired: Map<string, GithubApiResponseV1> }>();
function requestKey(input: Parameters<GithubApiClientV1['request']>[0]): string {
  const headers = Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([input.url, headers]);
}
export function getGithubConditionalChecksCache(client: GithubApiClientV1) {
  return cyclesByClient.get(client)?.state.checks;
}
/** Reuse only a witness already acquired by this admitted read, never a prior cycle. */
export function readGithubConditionalWitness(client: GithubApiClientV1, input: Parameters<GithubApiClientV1['request']>[0]) {
  const current = cyclesByClient.get(client)?.acquired.get(requestKey(input));
  return current === undefined ? client.request(input) : Promise.resolve(current);
}

export function clearGithubConditionalReads(lifetime: object): void {
  const state = statesByLifetime.get(lifetime);
  state?.representations.clear();
  state?.checks.clear();
  statesByLifetime.delete(lifetime);
}

/** Revalidate mutable REST representations within the admitted account lifetime.
 * Each read still passes through the native client's current HTTP admission.
 * Explicit cursor validators keep their existing caller-owned 304 contract.
 */
export async function requestGithubConditionalRead(
  client: GithubApiClientV1,
  input: Parameters<GithubApiClientV1['request']>[0],
  cycle?: GithubApiClientV1,
): Promise<GithubApiResponseV1> {
  if ((input.method ?? 'GET') !== 'GET' || input.body !== undefined
    || readTriageResponseHeaderV1(input.headers ?? {}, 'if-none-match') !== null
    || readTriageResponseHeaderV1(input.headers ?? {}, 'if-modified-since') !== null) {
    return client.request(input);
  }
  const lifetime = client.immutableDefinitionLifetime ?? client;
  let state = statesByLifetime.get(lifetime);
  if (state === undefined) {
    state = { representations: new Map(), checks: new Map() };
    statesByLifetime.set(lifetime, state);
  }
  let scope = cycle === undefined ? undefined : cyclesByClient.get(cycle);
  if (cycle !== undefined && scope?.state !== state) {
    scope = { state, acquired: new Map() };
    cyclesByClient.set(cycle, scope);
  }
  const { representations } = state;
  const key = requestKey(input);
  const prior = representations.get(key);
  const response = await client.request(prior === undefined ? input : {
    ...input, headers: { ...input.headers, 'If-None-Match': prior.etag },
  });
  if (response.status === 200) {
    const etag = readTriageResponseHeaderV1(response.headers, 'etag');
    if (etag) representations.set(key, { etag, response });
    else representations.delete(key);
  }
  if (response.status !== 304 || prior === undefined) {
    scope?.acquired.set(key, response);
    return response;
  }
  // Pagination and content metadata describe the retained representation. Timing
  // and budget headers always come from this revalidation, never the old 200.
  const headers: Record<string, string> = { ...response.headers };
  for (const name of ['etag', 'link', 'content-type']) {
    if (readTriageResponseHeaderV1(headers, name) !== null) continue;
    const value = readTriageResponseHeaderV1(prior.response.headers, name);
    if (value !== null) headers[name] = value;
  }
  const retained = { ...response, status: 200, headers, body: prior.response.body };
  representations.set(key, { etag: readTriageResponseHeaderV1(headers, 'etag') ?? prior.etag, response: retained });
  scope?.acquired.set(key, retained);
  return retained;
}
