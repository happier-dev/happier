import {
  assertConversationChannelsCoreCallerV1,
  classifyConversationProviderMaterializationFailureV1,
  rethrowConversationProviderLifecycleFailureV1,
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
  parseGithubConversationUrlV1,
  type ConversationConnectionTestResultV1,
  type ConversationDeliveryResultV1,
  type ConversationEndpointResolveResultV1,
  type ConversationPollResultV1,
  type ConversationPrincipalResolveResultV1,
  type ConversationProviderConnectionInputV1,
  type ConversationProviderFailureV1,
  type ConversationProviderSetupResultV1,
} from '@happier-dev/channels-protocol/v1';
import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  createGithubApiClient,
  createGithubNativeApiClient,
  decodeGithubJsonResponse,
  type GithubApiClientV1,
  type GithubApiMediaClientV1,
  type GithubApiResponseV1,
} from './observations/githubApiClient.js';
import {
  classifyGithubResponseFailure,
  isGithubInaccessibleResourceFailure,
  type GithubResponseFailureV1,
} from './observations/githubResponseFailure.js';
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
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_CONNECTED_ACCOUNT_SERVICE,
} from './observations/githubProviderContracts.js';
import { parseGithubRepositorySetupInput } from './observations/githubRepositorySetupInput.js';
import { parseGithubChannelEndpoint as parseEndpointId } from './observations/githubChannelEndpoint.js';
import { GithubPullRequestUpdateHistoryGapError } from './observations/githubPullRequestUpdates.js';

const githubTextEncoder = new TextEncoder();

type JsonRecord = Readonly<Record<string, unknown>>;

type GithubChannelConnectionV1 = Readonly<{
  config: GithubChannelProviderConfigV1;
  credentialRef: ConnectedAccountRef | null;
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
  assertConversationChannelsCoreCallerV1(context, {
    code: 'github_channels_core_caller_required',
    message: 'GitHub Channel setup requires a host-stamped plugin caller.',
  });
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

/**
 * The shared GitHub classifier decides what the provider said; this names that
 * answer in the Channels failure vocabulary. An unreachable or rejected
 * resource is a configuration problem, an exhausted limit is a throttle, and
 * anything GitHub did not decide stays retryable.
 */
function providerFailureForGithubResponse(response: GithubApiResponseV1): ConversationProviderFailureV1 {
  const nowMs = Date.now();
  const failure = classifyGithubResponseFailure(response, nowMs);
  const retryAfterMs = readBoundedGithubRetryAfterMs(failure, nowMs);
  if (retryAfterMs !== null) {
    return {
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs,
    };
  }
  if (failure.class === 'authentication') return { kind: 'notReady', reason: 'credentialInvalid' };
  if (failure.class === 'permission') return { kind: 'notReady', reason: 'permissionMissing' };
  if (isGithubInaccessibleResourceFailure(failure) || failure.class === 'unsupportedContract') {
    return { kind: 'notReady', reason: 'invalidConfiguration' };
  }
  return { kind: 'notReady', reason: 'network' };
}

/**
 * GitHub answered definitively about this credential, permission, or resource:
 * repeating the same request cannot change the answer, so a delivery that hit
 * it is never safe to retry.
 */
function isGithubDefiniteRejection(failure: GithubResponseFailureV1): boolean {
  return failure.class === 'authentication'
    || failure.class === 'permission'
    || failure.class === 'unsupportedContract'
    || isGithubInaccessibleResourceFailure(failure);
}

/**
 * Every Channels throttle bound, whichever GitHub limit family reported it. The
 * shared classifier decides whether this is rate-limited — including the
 * content-creation `422` GitHub says to retry — and C8 owns only the
 * Channels-result bound, including defensively normalizing an unexpected
 * non-safe retry instant before a strict contract projection.
 */
function readBoundedGithubRetryAfterMs(failure: GithubResponseFailureV1, nowMs: number): number | null {
  if (failure.class !== 'rateLimit') return null;
  const retryAfterMs = failure.retryNotBeforeMs === undefined ? null : failure.retryNotBeforeMs - nowMs;
  if (retryAfterMs === null || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
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
    if (error.code === 'plugin_service_unavailable') return { kind: 'notReady', reason: 'network' };
    if (error.code.includes('credential')) return { kind: 'notReady', reason: 'credentialInvalid' };
    return { kind: 'notReady', reason: error.retryable ? 'network' : 'invalidConfiguration' };
  }
  return { kind: 'notReady', reason: 'network' };
}

function readCredentialRef(value: ConnectedAccountRef | null, pluginId: string): ConnectedAccountRef | null {
  if (value !== null && !isGithubConnectedAccountRef(value, pluginId)) {
    throw new PluginError({
      code: 'github_channel_credential_unavailable',
      message: 'Select the configured GitHub Connected Account before invoking this Channel operation.',
    });
  }
  return value;
}

async function createGithubChannelApiClient(
  context: PluginInvocationContext,
  credentialRef: ConnectedAccountRef | null,
): Promise<GithubApiMediaClientV1 | ConversationProviderFailureV1> {
  try {
    return credentialRef === null ? await createGithubNativeApiClient(context, GITHUB_CONNECTED_ACCOUNT_SERVICE)
      : await createGithubApiClient(context, credentialRef);
  } catch (error) {
    return classifyConversationProviderMaterializationFailureV1(error, context.signal);
  }
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
  const parsed = parseGithubConversationUrlV1(trimmed);
  return parsed !== null && parsed.repository.toLowerCase() === repository.nameWithOwner.toLowerCase()
    ? parsed.number : null;
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
 * Neutralize mentions without growing a native-limit chunk. The fullwidth
 * at-sign remains readable and cannot become a GitHub notification mention.
 */
function formatGithubIssueCommentBodyForDelivery(content: string): string {
  return content.replaceAll('@', '＠');
}

export async function setupGithubChannels(
  input: unknown,
  context: PluginInvocationContext,
): Promise<ConversationProviderSetupResultV1> {
  assertChannelsCoreCaller(context);
  if (isRecord(input) && Object.keys(input).length === 1 && typeof input.repository === 'string') {
    const selected = await context.services.connectedAccounts.getBinding(GITHUB_CONNECTED_ACCOUNT_PURPOSE, { signal: context.signal });
    input = { ...input, credentialRef: selected?.account ?? null };
  }
  const setup = parseGithubRepositorySetupInput(input, context.plugin.id, true);
  const client = setup.credentialRef === null ? await createGithubNativeApiClient(context, GITHUB_CONNECTED_ACCOUNT_SERVICE)
    : await createGithubApiClient(context, setup.credentialRef);
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
    // GitHub's native REST comment limit; Channels owns lossless chunking.
    outboundTextLimit: { maximum: 65_536, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' },
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
    const client = await createGithubChannelApiClient(context, connection.credentialRef);
    if ('kind' in client) return ConversationConnectionTestResultV1Schema.parse(client);
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
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
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
    const client = await createGithubChannelApiClient(context, credentialRef);
    if ('kind' in client) return ConversationEndpointResolveResultV1Schema.parse(client);
    const response = await client.request({ url: issueUrl(config.repository, issueNumber) });
    if (response.status !== 200) throw new GithubApiResponseError(response);
    const issue = parseGithubIssue(decodeGithubJsonResponse(response));
    if (issue.number !== issueNumber) throw new RangeError('GitHub issue identity did not match the resolved number');
    return ConversationEndpointResolveResultV1Schema.parse({
      kind: 'resolved',
      candidates: [{
        kind: issue.kind,
        audience: 'shared',
        ...(issue.kind === 'githubPullRequest' ? { pullRequest: { repository: config.repository.nameWithOwner, number: issue.number } } : {}),
        id: githubIssueEndpointId(config.repository.repositoryId, issue),
        parentId: config.repository.repositoryId,
        parentLabel: config.repository.nameWithOwner,
        label: issue.title === undefined ? `#${issue.number}` : `#${issue.number} ${issue.title}`,
      }],
    });
  } catch (error) {
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
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
    const client = await createGithubChannelApiClient(context, credentialRef);
    if ('kind' in client) return ConversationPrincipalResolveResultV1Schema.parse(client);
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
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
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
    const client = await createGithubChannelApiClient(context, credentialRef);
    if ('kind' in client) return ConversationPollResultV1Schema.parse(client);
    return ConversationPollResultV1Schema.parse(await pollGithubIssueCommentsForChannels({
      client,
      config,
      checkpoint: request.checkpoint,
      limit: request.limit,
      connectionId: request.connectionId,
      providerConnectionKey: request.providerConnectionKey,
      ciEndpoints: request.bindings?.filter((binding) => binding.pullRequestUpdates === true || binding.scopedTriggerKind === 'ciFailed').map((binding) => binding.endpoint),
      feedbackEndpoints: request.bindings?.filter((binding) => binding.pullRequestUpdates === true || binding.scopedTriggerKind === 'prComment').map((binding) => binding.endpoint),
      commentDemand: request.bindings === undefined || request.bindings.some(binding => binding.endpoint.kind !== 'githubPullRequest'
        || binding.pullRequestUpdates === true || binding.scopedTriggerKind === 'prComment'),
      pullRequestEndpoints: request.bindings?.filter((binding) => binding.endpoint.kind === 'githubPullRequest').map((binding) => binding.endpoint),
      signal: context.signal,
    }));
  } catch (error) {
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
    if (error instanceof GithubIssueCommentCheckpointError || error instanceof GithubPullRequestUpdateHistoryGapError) {
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
  const nowMs = Date.now();
  const retryAfterMs = readBoundedGithubRetryAfterMs(classifyGithubResponseFailure(response, nowMs), nowMs);
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
  if (request.newThread !== undefined) return { kind: 'notReady', reason: 'unsupported' };
  const { config, credentialRef } = readGithubChannelConnection(request, context.plugin.id);
  // GitHub issue comments have one conversation endpoint and no native
  // comment-reply target. The core retains reply context for custody, but it
  // cannot alter this provider's already-frozen issue or pull-request route.
  const body = formatGithubIssueCommentBodyForDelivery(request.content.text);
  const endpoint = parseEndpointId(request.endpoint, config.repository.repositoryId);
  const client = await createGithubChannelApiClient(context, credentialRef);
  if ('kind' in client) {
    return ConversationDeliveryResultV1Schema.parse({
      kind: 'notDelivered', retry: client.reason === 'network' ? 'safe' : 'never',
    });
  }
  let revalidated: GithubApiResponseV1;
  try {
    revalidated = await client.request({ url: issueUrl(config.repository, endpoint.issueNumber) });
  } catch (error) {
    rethrowConversationProviderLifecycleFailureV1(error, context.signal);
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
  try {
    const response = await client.request({
      url: commentUrl(config.repository, endpoint.issueNumber),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // GitHub has no request-level mention suppression switch. Acceptance
      // and any service-side text limit remain owned by the REST API.
      body: githubTextEncoder.encode(JSON.stringify({ body })),
    });
    if (response.status === 201) {
      const value = decodeGithubJsonResponse(response);
      if (!isRecord(value)) throw new RangeError('GitHub comment delivery response must be an object');
      return ConversationDeliveryResultV1Schema.parse({
        kind: 'delivered', providerMessageIds: [readGithubPositiveDecimal(value.id, 'delivered comment ID')],
      });
    }
    const deliveryFailureAtMs = Date.now();
    const failure = classifyGithubResponseFailure(response, deliveryFailureAtMs);
    const retryAfterMs = readBoundedGithubRetryAfterMs(failure, deliveryFailureAtMs);
    if (retryAfterMs !== null) {
      return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'after', retryAfterMs });
    }
    if (isGithubDefiniteRejection(failure)) {
      return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
    }
    return ConversationDeliveryResultV1Schema.parse({ kind: 'outcomeUnknown' });
  } catch (error) {
    if (context.signal.aborted) throw error;
    return ConversationDeliveryResultV1Schema.parse({ kind: 'outcomeUnknown' });
  }
}
