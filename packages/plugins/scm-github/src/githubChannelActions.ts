import {
  MAX_CONVERSATION_RETRY_AFTER_MS,
  ConversationConnectionTestInputV1Schema,
  ConversationConnectionTestResultV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationDeliveryResultV1Schema,
  ConversationEndpointResolveInputV1Schema,
  ConversationEndpointResolveResultV1Schema,
  ConversationPollInputV1Schema,
  ConversationPollResultV1Schema,
  ConversationPrincipalResolveInputV1Schema,
  ConversationPrincipalResolveResultV1Schema,
  ConversationProviderConnectionInputV1Schema,
  ConversationProviderSetupResultV1Schema,
  compareCanonicalConversationResolutionCandidatesV1,
  type ConversationConnectionTestResultV1,
  type ConversationDeliveryResultV1,
  type ConversationEndpointResolveResultV1,
  type ConversationPollResultV1,
  type ConversationPrincipalResolveResultV1,
  type ConversationProviderConnectionInputV1,
  type ConversationProviderFailureV1,
  type ConversationProviderSetupResultV1,
  type ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  createGithubApiClient,
  decodeGithubJsonResponse,
  readGithubContentCreationThrottleRetryAfterMs,
  readGithubRateLimitRetryAfterMs,
  type GithubApiClientV1,
  type GithubApiResponseV1,
} from './observations/githubApiClient.js';
import {
  GithubApiResponseError,
  resolveGithubRepositoryWithClient,
} from './observations/githubRepositoryResolution.js';
import {
  GithubIssueCommentCheckpointError,
  GithubIssueCommentPollResponseError,
  githubIssueEndpointId,
  parseGithubIssue,
  pollGithubIssueCommentsForChannels,
} from './observations/githubIssueCommentPollRuntime.js';
import {
  createGithubRepositorySourceConfig,
  isGithubConnectedAccountRef,
  parseGithubChannelProviderConfig,
  readGithubPositiveDecimal,
  type GithubChannelProviderConfigV1,
  type GithubRepositorySourceConfigV1,
} from './observations/githubProviderContracts.js';
import { parseGithubRepositorySetupInput } from './observations/githubRepositorySetupInput.js';

const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const GITHUB_ISSUE_COMMENT_BODY_MAX_UTF8_BYTES = 65_536;
const githubTextEncoder = new TextEncoder();

type JsonRecord = Readonly<Record<string, unknown>>;

type GithubChannelConnectionV1 = Readonly<{
  config: GithubChannelProviderConfigV1;
  credentialRef: ConnectedAccountRef;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RangeError(`GitHub ${label} must be a nonempty string`);
  }
  return value.trim();
}

function assertChannelsCoreCaller(context: PluginInvocationContext): void {
  if (
    context.surface !== 'plugin'
    || context.caller?.kind !== 'plugin'
    || context.caller.pluginId !== CHANNELS_CORE_PLUGIN_ID
  ) {
    throw new PluginError({
      code: 'github_channels_core_caller_required',
      message: 'GitHub Channel setup must be invoked by the Channels core plugin.',
    });
  }
}

function userUrl(): string {
  return 'https://api.github.com/user';
}

function issueUrl(repository: GithubRepositorySourceConfigV1, issueNumber: number): string {
  return new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}`,
    'https://api.github.com',
  ).toString();
}

function commentUrl(repository: GithubRepositorySourceConfigV1, issueNumber: number): string {
  return new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}/comments`,
    'https://api.github.com',
  ).toString();
}

/** The repository issue-comment collection this Channel observes, read once. */
function repositoryIssueCommentsProbeUrl(repository: GithubRepositorySourceConfigV1): string {
  const url = new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/comments`,
    'https://api.github.com',
  );
  url.searchParams.set('per_page', '1');
  return url.toString();
}

/**
 * A PAT that authenticates is not a PAT that can reach this repository's issue
 * comments: the account can hold repository access while the token withholds
 * the Issues permission. Readiness therefore exercises the exact collection the
 * Channel polls, so a credential that cannot observe the conversation is
 * refused at connection time instead of at the first silent poll failure.
 */
async function assertRepositoryIssueCommentsReadable(
  client: GithubApiClientV1,
  repository: GithubRepositorySourceConfigV1,
): Promise<void> {
  const response = await client.request({ url: repositoryIssueCommentsProbeUrl(repository) });
  if (response.status !== 200) throw new GithubApiResponseError(response);
}

function parseGithubUser(value: unknown): Readonly<{ id: string; label: string }> {
  if (!isRecord(value)) throw new RangeError('GitHub user response must be an object');
  return Object.freeze({
    id: readGithubPositiveDecimal(value.id, 'user ID'),
    label: readString(value.login, 'user login'),
  });
}

async function readConfiguredIdentityWithClient(
  client: GithubApiClientV1,
): Promise<Readonly<{ id: string; label: string }>> {
  const response = await client.request({ url: userUrl() });
  if (response.status !== 200) throw new GithubApiResponseError(response);
  return parseGithubUser(decodeGithubJsonResponse(response));
}

function providerFailureForGithubResponse(response: GithubApiResponseV1): ConversationProviderFailureV1 {
  if (response.status === 401) return { kind: 'notReady', reason: 'credentialInvalid' };
  const retryAfterMs = readBoundedGithubRateLimitRetryAfterMs(response);
  if (retryAfterMs !== null) {
    return {
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs,
    };
  }
  if (response.status === 403) return { kind: 'notReady', reason: 'permissionMissing' };
  if (response.status === 404 || response.status === 410 || response.status === 422) {
    return { kind: 'notReady', reason: 'invalidConfiguration' };
  }
  return { kind: 'notReady', reason: 'network' };
}

/**
 * Every Channels throttle bound, whichever GitHub limit family reported it. A
 * content-creation `422` is a throttle here for the same reason a `403`
 * secondary limit is: GitHub says to retry it, so it must not settle as a
 * permanent Channel failure.
 */
function readBoundedGithubRateLimitRetryAfterMs(response: GithubApiResponseV1): number | null {
  const retryAfterMs = readGithubRateLimitRetryAfterMs(response)
    ?? readGithubContentCreationThrottleRetryAfterMs(response);
  if (retryAfterMs === null) return null;
  // The shared GitHub classifier decides whether this is rate-limited. C8
  // owns only the Channels-result bound, including defensively normalizing an
  // unexpected non-safe helper result before a strict contract projection.
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    return MAX_CONVERSATION_RETRY_AFTER_MS;
  }
  return Math.min(retryAfterMs, MAX_CONVERSATION_RETRY_AFTER_MS);
}

function providerFailure(error: unknown): ConversationProviderFailureV1 {
  if (error instanceof GithubApiResponseError) return providerFailureForGithubResponse(error.response);
  if (error instanceof GithubIssueCommentPollResponseError) {
    return providerFailureForGithubResponse(error.response);
  }
  if (isPluginError(error)) {
    if (error.code.includes('credential')) return { kind: 'notReady', reason: 'credentialInvalid' };
    return { kind: 'notReady', reason: error.retryable ? 'network' : 'invalidConfiguration' };
  }
  return { kind: 'notReady', reason: 'network' };
}

function rethrowPreEffectLifecycleFailure(error: unknown, signal: AbortSignal): void {
  if (
    signal.aborted
    || (isPluginError(error) && error.code === 'plugin_final_generation_retired')
  ) {
    throw error;
  }
}

function readCredentialRef(value: ConnectedAccountRef | null, pluginId: string): ConnectedAccountRef {
  if (!isGithubConnectedAccountRef(value, pluginId)) {
    throw new PluginError({
      code: 'github_channel_credential_unavailable',
      message: 'Select the configured GitHub Connected Account before invoking this Channel operation.',
    });
  }
  return value;
}

function readGithubChannelConnection(
  input: ConversationProviderConnectionInputV1,
  pluginId: string,
): GithubChannelConnectionV1 {
  const config = parseGithubChannelProviderConfig(input.providerConfig);
  if (input.providerConnectionKey !== `github:repository:${config.repository.repositoryId}`) {
    throw new PluginError({
      code: 'github_channel_connection_mismatch',
      message: 'GitHub Channel configuration does not match its immutable repository connection key.',
    });
  }
  const credentialRef = readCredentialRef(input.credentialRef, pluginId);
  // The current Connected Account is the exact PAT selector, while
  // integrationPrincipal is the authenticated user returned for that PAT.
  // Future App-installation support needs its own canonical account mode and
  // supported App identity path rather than reinterpreting this PAT flow.
  return Object.freeze({ config, credentialRef });
}

function decodeIssueNumber(query: string, repository: GithubRepositorySourceConfigV1): number | null {
  const trimmed = query.trim();
  const direct = /^#?([1-9][0-9]*)$/u.exec(trimmed);
  if (direct) return Number(direct[1]);
  try {
    const url = new URL(trimmed);
    if (url.origin !== 'https://github.com') return null;
    const expected = `/${repository.owner}/${repository.name}/`;
    if (!url.pathname.toLowerCase().startsWith(expected.toLowerCase())) return null;
    const match = /^\/(?:[^/]+)\/(?:[^/]+)\/(?:issues|pull)\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function parseEndpointId(
  endpoint: ConversationResolvedEndpointV1,
  repositoryId: string,
): Readonly<{ issueId: string; issueNumber: number; kind: 'githubIssue' | 'githubPullRequest' }> {
  if (endpoint.kind !== 'githubIssue' && endpoint.kind !== 'githubPullRequest') {
    throw new PluginError({ code: 'github_channel_endpoint_invalid', message: 'GitHub delivery requires an issue or pull-request endpoint.' });
  }
  const match = /^github:repository:([1-9][0-9]*):issue:([1-9][0-9]*):number:([1-9][0-9]*)$/u.exec(endpoint.id);
  if (!match || match[1] !== repositoryId) {
    throw new PluginError({ code: 'github_channel_endpoint_invalid', message: 'GitHub delivery endpoint does not belong to this configured repository.' });
  }
  const issueNumber = Number(match[3]);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new PluginError({ code: 'github_channel_endpoint_invalid', message: 'GitHub delivery endpoint has an invalid issue number.' });
  }
  return Object.freeze({ issueId: match[2]!, issueNumber, kind: endpoint.kind });
}

function makeChannelConfig(
  repository: GithubRepositorySourceConfigV1,
  identity: Readonly<{ id: string; label: string }>,
): GithubChannelProviderConfigV1 {
  return Object.freeze({
    v: 1,
    repository,
    integrationPrincipal: identity,
  });
}

/**
 * The generic delivery contract permits a larger payload than one GitHub
 * comment. Format and split at this provider boundary, because neutralizing a
 * mention adds UTF-8 bytes and the core owns neither GitHub's body format nor
 * its comment boundaries.
 */
function splitGithubIssueCommentBodiesForDelivery(content: string): readonly string[] {
  const bodies: string[] = [];
  let current = '';
  let currentUtf8Bytes = 0;

  for (const codePoint of content) {
    // Keep the suppression pair atomic: a chunk boundary cannot leave an
    // un-neutralized `@` before a mention target in the preceding comment.
    const formatted = codePoint === '@' ? '@\u200B' : codePoint;
    const formattedUtf8Bytes = githubTextEncoder.encode(formatted).byteLength;
    if (currentUtf8Bytes + formattedUtf8Bytes > GITHUB_ISSUE_COMMENT_BODY_MAX_UTF8_BYTES) {
      bodies.push(current);
      current = formatted;
      currentUtf8Bytes = formattedUtf8Bytes;
      continue;
    }
    current += formatted;
    currentUtf8Bytes += formattedUtf8Bytes;
  }

  if (current) bodies.push(current);
  return bodies;
}

export async function setupGithubChannels(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderSetupResultV1> {
  assertChannelsCoreCaller(context);
  const setup = parseGithubRepositorySetupInput(input, context.plugin.id);
  const client = await createGithubApiClient(context, setup.credentialRef);
  const [repository, identity] = await Promise.all([
    resolveGithubRepositoryWithClient(client, setup.repository),
    readConfiguredIdentityWithClient(client),
  ]);
  context.signal.throwIfAborted();
  return ConversationProviderSetupResultV1Schema.parse({
    v: 1,
    credentialRef: setup.credentialRef,
    providerConnectionKey: `github:repository:${repository.repositoryId}`,
    providerConfigVersion: 1,
    providerConfig: makeChannelConfig(repository, identity),
    integrationPrincipal: identity,
    // Generic webhook dispatch has not yet supplied the authenticated endpoint
    // identity required to bind the durable-push consumer. Do not expose a
    // selectable transport until that one canonical host contract is live.
    supportedTransports: ['checkpointedPull'],
    recommendedTransport: 'checkpointedPull',
    overlapSafety: 'safe',
    replayContinuity: 'checkpointed',
    outboundTextLimit: { maximum: GITHUB_ISSUE_COMMENT_BODY_MAX_UTF8_BYTES, unit: 'utf8Bytes' },
  });
}

export async function testGithubChannelConnection(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationConnectionTestResultV1> {
  assertChannelsCoreCaller(context);
  try {
    const request = ConversationConnectionTestInputV1Schema.parse(input);
    if (request.selectedTransport !== 'checkpointedPull') {
      return ConversationConnectionTestResultV1Schema.parse({
        kind: 'notReady',
        reason: 'unsupported',
        diagnostic: 'GitHub Channels supports checkpointed polling only.',
      });
    }
    const connection = readGithubChannelConnection(request, context.plugin.id);
    const client = await createGithubApiClient(context, connection.credentialRef);
    const identity = await readConfiguredIdentityWithClient(client);
    if (identity.id !== connection.config.integrationPrincipal.id) {
      return ConversationConnectionTestResultV1Schema.parse({
        kind: 'notReady',
        reason: 'credentialInvalid',
        diagnostic: 'The selected GitHub account no longer matches this Channel connection.',
      });
    }
    context.signal.throwIfAborted();
    await assertRepositoryIssueCommentsReadable(client, connection.config.repository);
    return ConversationConnectionTestResultV1Schema.parse({
      kind: 'ready',
      integrationPrincipal: identity,
      providerConnectionKey: request.providerConnectionKey,
    });
  } catch (error) {
    rethrowPreEffectLifecycleFailure(error, context.signal);
    return ConversationConnectionTestResultV1Schema.parse(providerFailure(error));
  }
}

export async function resolveGithubChannelEndpoint(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationEndpointResolveResultV1> {
  assertChannelsCoreCaller(context);
  try {
    const request = ConversationEndpointResolveInputV1Schema.parse(input);
    const { config, credentialRef } = readGithubChannelConnection(request, context.plugin.id);
    if (request.kinds !== undefined && !request.kinds.some((kind) => kind === 'githubIssue' || kind === 'githubPullRequest')) {
      return ConversationEndpointResolveResultV1Schema.parse({ kind: 'resolved', candidates: [] });
    }
    const issueNumber = decodeIssueNumber(request.query, config.repository);
    if (issueNumber === null) return ConversationEndpointResolveResultV1Schema.parse({ kind: 'resolved', candidates: [] });
    const client = await createGithubApiClient(context, credentialRef);
    const response = await client.request({ url: issueUrl(config.repository, issueNumber) });
    if (response.status !== 200) throw new GithubApiResponseError(response);
    const issue = parseGithubIssue(decodeGithubJsonResponse(response));
    if (issue.number !== issueNumber) throw new RangeError('GitHub issue identity did not match the resolved number');
    return ConversationEndpointResolveResultV1Schema.parse({
      kind: 'resolved',
      candidates: [{
        kind: issue.kind,
        audience: 'shared',
        id: githubIssueEndpointId(config.repository.repositoryId, issue),
        parentId: config.repository.repositoryId,
        parentLabel: config.repository.nameWithOwner,
        label: issue.title === undefined ? `#${issue.number}` : `#${issue.number} ${issue.title}`,
      }],
    });
  } catch (error) {
    rethrowPreEffectLifecycleFailure(error, context.signal);
    return ConversationEndpointResolveResultV1Schema.parse(providerFailure(error));
  }
}

export async function resolveGithubChannelPrincipal(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationPrincipalResolveResultV1> {
  assertChannelsCoreCaller(context);
  try {
    const request = ConversationPrincipalResolveInputV1Schema.parse(input);
    const { config, credentialRef } = readGithubChannelConnection(request, context.plugin.id);
    parseEndpointId(request.endpoint, config.repository.repositoryId);
    const url = new URL('/search/users', 'https://api.github.com');
    url.searchParams.set('q', request.query);
    url.searchParams.set('per_page', '50');
    const client = await createGithubApiClient(context, credentialRef);
    const response = await client.request({ url: url.toString() });
    if (response.status !== 200) throw new GithubApiResponseError(response);
    const payload = decodeGithubJsonResponse(response);
    const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
    const candidatesById = new Map<string, {
      id: string;
      label: string;
      kind: 'human' | 'bot';
    }>();
    for (const value of items) {
      if (!isRecord(value) || (value.type !== 'User' && value.type !== 'Bot')) continue;
      try {
        const candidate = {
          id: readGithubPositiveDecimal(value.id, 'principal ID'),
          label: readString(value.login, 'principal login'),
          kind: value.type === 'Bot' ? 'bot' as const : 'human' as const,
        };
        if (!candidatesById.has(candidate.id)) candidatesById.set(candidate.id, candidate);
      } catch {
        // GitHub can include malformed search rows; ignore those rows while
        // retaining valid candidates from the same response.
      }
    }
    const candidates = [...candidatesById.values()]
      .sort(compareCanonicalConversationResolutionCandidatesV1);
    return ConversationPrincipalResolveResultV1Schema.parse({ kind: 'resolved', candidates });
  } catch (error) {
    rethrowPreEffectLifecycleFailure(error, context.signal);
    return ConversationPrincipalResolveResultV1Schema.parse(providerFailure(error));
  }
}

export async function pollGithubChannelObservations(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationPollResultV1> {
  assertChannelsCoreCaller(context);
  try {
    const request = ConversationPollInputV1Schema.parse(input);
    const { config, credentialRef } = readGithubChannelConnection(request, context.plugin.id);
    const client = await createGithubApiClient(context, credentialRef);
    return ConversationPollResultV1Schema.parse(await pollGithubIssueCommentsForChannels({
      client,
      config,
      checkpoint: request.checkpoint,
      limit: request.limit,
      connectionId: request.connectionId,
      providerConnectionKey: request.providerConnectionKey,
    }));
  } catch (error) {
    rethrowPreEffectLifecycleFailure(error, context.signal);
    if (error instanceof GithubIssueCommentCheckpointError) {
      return ConversationPollResultV1Schema.parse({
        kind: 'historyGap',
        reason: 'providerHistoryUnavailable',
      });
    }
    return ConversationPollResultV1Schema.parse(providerFailure(error));
  }
}

function safeRetryBeforeGithubCommentPost(
  retryAfterMs: number | null = null,
): ConversationDeliveryResultV1 {
  return ConversationDeliveryResultV1Schema.parse({
    kind: 'notDelivered',
    retry: retryAfterMs === null ? 'safe' : 'after',
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  });
}

function prePostGithubResponseResult(response: GithubApiResponseV1): ConversationDeliveryResultV1 {
  const retryAfterMs = readBoundedGithubRateLimitRetryAfterMs(response);
  if (retryAfterMs !== null || response.status >= 500) {
    return safeRetryBeforeGithubCommentPost(retryAfterMs);
  }
  return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
}

export async function deliverGithubChannelMessage(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationDeliveryResultV1> {
  assertChannelsCoreCaller(context);
  const request = ConversationDeliveryInputV1Schema.parse(input);
  const { config, credentialRef } = readGithubChannelConnection(request, context.plugin.id);
  // GitHub issue comments have one conversation endpoint and no native
  // comment-reply target. The core retains reply context for custody, but it
  // cannot alter this provider's already-frozen issue or pull-request route.
  const bodies = splitGithubIssueCommentBodiesForDelivery(request.content);
  if (bodies.length === 0) {
    return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
  }
  const endpoint = parseEndpointId(request.endpoint, config.repository.repositoryId);
  let client: GithubApiClientV1;
  try {
    client = await createGithubApiClient(context, credentialRef);
  } catch (error) {
    rethrowPreEffectLifecycleFailure(error, context.signal);
    if (isPluginError(error)) {
      if (error.retryable || error.code === 'plugin_service_unavailable') {
        return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'safe' });
      }
      return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
    }
    // Account materialization finishes before a GitHub request can be made.
    return safeRetryBeforeGithubCommentPost();
  }
  let revalidated: GithubApiResponseV1;
  try {
    revalidated = await client.request({ url: issueUrl(config.repository, endpoint.issueNumber) });
  } catch (error) {
    rethrowPreEffectLifecycleFailure(error, context.signal);
    // This is the endpoint GET, not a comment POST, so GitHub has no message
    // effect to reconcile and the normal delivery owner may retry it safely.
    return safeRetryBeforeGithubCommentPost();
  }
  if (revalidated.status !== 200) {
    return prePostGithubResponseResult(revalidated);
  }
  let issue: ReturnType<typeof parseGithubIssue>;
  try {
    issue = parseGithubIssue(decodeGithubJsonResponse(revalidated));
  } catch (error) {
    if (context.signal.aborted) throw error;
    // A malformed endpoint representation is still known to precede any
    // comment POST, so it retains the same safe retry boundary as GET I/O.
    return safeRetryBeforeGithubCommentPost();
  }
  if (issue.id !== endpoint.issueId || issue.number !== endpoint.issueNumber || issue.kind !== endpoint.kind) {
    return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
  }
  const providerMessageIds: string[] = [];
  for (const [index, body] of bodies.entries()) {
    try {
      const response = await client.request({
        url: commentUrl(config.repository, endpoint.issueNumber),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // GitHub has no request-level mention suppression switch. The body is
        // neutralized and bounded before every provider request.
        body: githubTextEncoder.encode(JSON.stringify({ body })),
      });
      if (response.status === 201) {
        const value = decodeGithubJsonResponse(response);
        if (!isRecord(value)) throw new RangeError('GitHub comment delivery response must be an object');
        providerMessageIds.push(readGithubPositiveDecimal(value.id, 'delivered comment ID'));
        continue;
      }
      const retryAfterMs = readBoundedGithubRateLimitRetryAfterMs(response);
      if (retryAfterMs !== null) {
        if (providerMessageIds.length === 0) {
          return ConversationDeliveryResultV1Schema.parse({
            kind: 'notDelivered',
            retry: 'after',
            retryAfterMs,
          });
        }
        return ConversationDeliveryResultV1Schema.parse({
          kind: 'partial', providerMessageIds, failedChunk: index, retrySafe: false,
        });
      }
      if ([401, 403, 404, 410, 422].includes(response.status)) {
        if (providerMessageIds.length === 0) {
          return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
        }
        return ConversationDeliveryResultV1Schema.parse({
          kind: 'partial', providerMessageIds, failedChunk: index, retrySafe: false,
        });
      }
      return ConversationDeliveryResultV1Schema.parse({
        kind: 'outcomeUnknown',
        ...(providerMessageIds.length === 0 ? {} : { providerMessageIds }),
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      return ConversationDeliveryResultV1Schema.parse({
        kind: 'outcomeUnknown',
        ...(providerMessageIds.length === 0 ? {} : { providerMessageIds }),
      });
    }
  }
  return ConversationDeliveryResultV1Schema.parse({ kind: 'delivered', providerMessageIds });
}
