import type { GithubTriageInvocationContext } from './invocation.js';
import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, readTriageResponseHeaderV1, TriageReadAttentionCredentialInputV1Schema, type TriageReadAttentionResultV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_API_ORIGIN } from '../observations/githubProviderContracts.js';
import { openGithubTriageClient, resolveGithubTriageInstance } from './operations.js';
import { buildGithubEntryLocalRef } from './identity.js';
import { runGithubTriageGet } from './get.js';
import { toTriageFailure, toTriageGetResult } from './mapping/protocol.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from './errors.js';
import { readValidatedGithubFollowUpPage, validateGithubFollowUpPageUrl } from './scan/link.js';

const firstUrl = `${GITHUB_API_ORIGIN}/notifications?all=true&per_page=50`;
const invalid = { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_attention_invalid' } } as const;
const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** One finite provider page. The caller retains only an opaque conditional/pagination cursor. */
export async function readGithubAttention(input: unknown, context: GithubTriageInvocationContext): Promise<TriageReadAttentionResultV1> {
  const parsed = TriageReadAttentionCredentialInputV1Schema.safeParse(input);
  if (!parsed.success) return invalid;
  const { instance, cursor } = parsed.data;
  const resolved = resolveGithubTriageInstance(instance);
  if (!resolved.ok) return { kind: 'failed', failure: resolved.failure };
  let url = firstUrl;
  let lastModified: string | undefined;
  if (cursor) {
    const retained = decodeTriagePagingTokenV1(cursor.token);
    if (!retained || retained.configuration !== instance.configuration.token || typeof retained.url !== 'string'
      || retained.lastModified !== undefined && typeof retained.lastModified !== 'string') return invalid;
    // A provider continuation freezes the incremental filter as well as the page size.
    const feedUrl = new URL(firstUrl);
    try {
      const since = new URL(retained.url).searchParams.get('since');
      if (since !== null) feedUrl.searchParams.set('since', since);
    } catch { return invalid; }
    if (retained.url !== firstUrl && validateGithubFollowUpPageUrl(retained.url, feedUrl.toString()) === null) return invalid;
    url = retained.url;
    lastModified = typeof retained.lastModified === 'string' ? retained.lastModified : undefined;
  }
  const opened = await openGithubTriageClient(instance, context);
  if (!opened.ok) return { kind: 'failed', failure: opened.failure };
  try {
    context.signal.throwIfAborted();
    const head = url === firstUrl;
    if (head && lastModified !== undefined) {
      const feedUrl = new URL(firstUrl);
      feedUrl.searchParams.set('since', new Date(lastModified).toISOString().replace('.000Z', 'Z'));
      url = feedUrl.toString();
    }
    const response = await opened.client.request({ url, ...(lastModified === undefined || !head ? {} : { headers: { 'If-Modified-Since': lastModified } }) });
    if (response.status !== 304 && response.status !== 200) return { kind: 'failed', failure: toTriageFailure(classifyGithubResponseFailure(response, context.invokedAtMs)) };
    const header = (name: string) => readTriageResponseHeaderV1(response.headers, name) ?? undefined;
    const seconds = Number(header('x-poll-interval'));
    const pollIntervalMs = Number.isSafeInteger(seconds) && seconds > 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
    // Later pages must not advance past changes arriving after this walk's head.
    const modified = head ? header('last-modified') ?? lastModified : lastModified;
    const next = response.status === 304 ? { kind: 'ended' as const } : readValidatedGithubFollowUpPage(response.headers, url);
    if (next.kind === 'invalid') return invalid;
    const token = encodeTriagePagingTokenV1({ v: 1, configuration: instance.configuration.token,
      url: next.kind === 'next' ? next.url : firstUrl, ...(modified === undefined ? {} : { lastModified: modified }) });
    if (token === null) return invalid;
    const items: Extract<TriageReadAttentionResultV1, { kind: 'page' }>['items'][number][] = [];
    if (response.status === 200) {
      const body: unknown = JSON.parse(new TextDecoder().decode(response.body));
      if (!Array.isArray(body)) return invalid;
      for (const raw of body) {
        context.signal.throwIfAborted();
        const row = record(raw); const subject = record(row?.subject); const repository = record(row?.repository);
        if (subject?.type !== 'PullRequest' || typeof subject.url !== 'string') continue;
        const route = new URL(subject.url);
        const path = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)$/u.exec(route.pathname);
        if (route.origin !== GITHUB_API_ORIGIN || route.username || route.password || route.hash || !path) continue;
        const repositoryKey = `${path[1]}/${path[2]}`;
        if (resolved.configuration.selection.kind !== 'all' && !resolved.configuration.selection.unitIds.includes(repositoryKey)) continue;
        const localRef = buildGithubEntryLocalRef({ kindId: 'pull-request', repositoryId: repository?.id, nativeItemId: path[3] });
        if (!localRef) continue;
        // A reason can change to state_change; terminal facts still retire the original review item.
        const current = toTriageGetResult((await runGithubTriageGet({ localRef, routingToken: repositoryKey }, {
          client: opened.client, now: () => context.invokedAtMs, signal: context.signal,
        })).observation, instance);
        // Do not acknowledge a new feed watermark until its review facts were read.
        if (current.kind === 'unresolved') return { kind: 'failed', failure: current.failure };
        if (current.kind !== 'present') continue;
        const terminal = current.snapshot.state.presentation === 'resolved' || current.snapshot.state.presentation === 'closed';
        if (row?.reason !== 'review_requested' && !terminal) continue;
        items.push({ localRef, reason: 'reviewRequested', type: 'decision', title: current.snapshot.title, resolved: terminal });
      }
    }
    return { kind: 'page', items, cursor: { v: 1, token }, nextPage: next.kind === 'next', ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }) };
  } catch (error) {
    context.signal.throwIfAborted();
    return { kind: 'failed', failure: toTriageFailure(classifyGithubTransportFailure(error)) };
  }
}
