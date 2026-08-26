import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { encodeBitbucketConfiguration } from '../instance.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import {
  BitbucketCommentResolutionResultV1Schema,
  BitbucketMutationResultV1Schema,
} from './mutationContracts.js';
import {
  BITBUCKET_TRIAGE_MUTATION_ACTION_IDS,
  declineBitbucketPullRequestAction,
  mergeBitbucketPullRequestAction,
  resolveBitbucketCommentAction,
  unresolveBitbucketCommentAction,
} from './mutationActions.js';
import {
  accountRef,
  createConnectedAccountsStub,
  createHttpStub,
  createInvocationContext,
  type StubReply,
} from './testSupport.js';

/**
 * The deciding proofs for the four enabled Bitbucket pull-request writes.
 *
 * Everything below the two boundary doubles runs for real: admission, the currentness gate, route
 * construction, the request body, response branching, the confirming read, the entry decoder and
 * the published result schema. Each assertion targets a way a merge can be silently wrong — a
 * write against a head the user never saw, a queued merge rendered as merged, a documented
 * terminal refusal folded into a generic error — rather than restating the happy path.
 */

const WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
const COLLISION_SCOPE = `bitbucket:${REPOSITORY_UUID}`;
const ENTRY_ID = '42';
const OBSERVED_HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const ADVANCED_HEAD = '0f9e8d7c6b5a49382716059f8e7d6c5b4a392817';
const VIEWER_UUID = '{9f8e7d6c-5b4a-4938-8271-6059f8e7d6c5}';

// The braces in a Bitbucket UUID are path-encoded by the one URL owner, so the fixture addresses
// exactly the URL the source builds rather than a readable approximation of it.
const PULL_REQUEST_URL = 'https://api.bitbucket.org/2.0/repositories'
  + `/${encodeURIComponent(WORKSPACE_UUID)}/${encodeURIComponent(REPOSITORY_UUID)}`
  + `/pullrequests/${ENTRY_ID}`;
const MERGE_URL = `${PULL_REQUEST_URL}/merge`;
const DECLINE_URL = `${PULL_REQUEST_URL}/decline`;

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid: WORKSPACE_UUID });
  if (!encoded.ok) throw new Error('fixture configuration must encode');
  return {
    v: 1,
    instance: {
      source: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: {
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      account: accountRef('account-1'),
    },
    localInstanceKey: WORKSPACE_UUID,
    configuration: { v: 1, token: encoded.token },
  } as TriageConfiguredSourceInstanceV1;
}

const LOCAL_REF = Object.freeze({
  kindId: 'pull-request',
  collisionScope: COLLISION_SCOPE,
  entryId: ENTRY_ID,
});

function mergeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: LOCAL_REF,
    observedHeadCommit: OBSERVED_HEAD,
    closeSourceBranch: false,
    mergeStrategy: 'squash',
    ...overrides,
  };
}

function declineInput() {
  return { v: 1, instance: configuredInstance(), localRef: LOCAL_REF };
}

/** One Bitbucket pull-request body, at whichever state and head the case needs. */
function pullRequest(
  state: 'OPEN' | 'MERGED' | 'DECLINED',
  headCommit: string = OBSERVED_HEAD,
): Readonly<Record<string, unknown>> {
  return {
    type: 'pullrequest',
    id: Number(ENTRY_ID),
    title: 'Tighten the merge gate',
    state,
    destination: { repository: { uuid: REPOSITORY_UUID, full_name: 'example/repository' } },
    source: {
      branch: { name: 'feature' },
      commit: { hash: headCommit },
      repository: { uuid: REPOSITORY_UUID, full_name: 'example/repository' },
    },
    author: { uuid: VIEWER_UUID, nickname: 'author' },
    created_on: '2026-08-01T00:00:00Z',
    updated_on: '2026-08-02T00:00:00Z',
  };
}

/**
 * A harness whose pull-request reads walk a scripted sequence of states.
 *
 * A mutation reads the entry before the write and again after it, so a fixture that answered the
 * same body every time could not tell a confirmed effect from an unconfirmed one.
 */
function harness(input: Readonly<{
  reads: readonly Readonly<Record<string, unknown>>[];
  write?: (url: string) => StubReply | undefined;
  signal?: AbortSignal;
}>) {
  let read = 0;
  const { http, requests } = createHttpStub((url) => {
    if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID, nickname: 'viewer' } };
    const written = input.write?.(url);
    if (written !== undefined) return written;
    if (url === PULL_REQUEST_URL) {
      const body = input.reads[Math.min(read, input.reads.length - 1)];
      read += 1;
      return { body };
    }
    return undefined;
  });
  const { connectedAccounts } = createConnectedAccountsStub({
    accounts: [{ accountId: 'account-1' }],
  });
  return {
    context: createInvocationContext(connectedAccounts, http, input.signal),
    requests,
  };
}

const writesTo = (requests: readonly { url: string; method: string }[], url: string): number =>
  requests.filter((request) => request.url === url && request.method !== 'GET').length;

/* --------------------------------------------------------------------- merge */

describe('Bitbucket pull-request merge', () => {
  it('refuses a merge whose pinned head is no longer the head, with zero writes', async () => {
    const { context, requests } = harness({ reads: [pullRequest('OPEN', ADVANCED_HEAD)] });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('an advanced head must refuse the merge');
    expect(settled.reason).toBe('head-advanced');
    // The refusal carries the entity the fresh read observed, so the host can re-render the head
    // that is actually there instead of forcing a blind retry.
    expect(settled.observation.kind).toBe('present');
    expect(writesTo(requests, MERGE_URL)).toBe(0);
  });

  it('sends the caller\'s exact merge parameters once and confirms the merge with a fresh read', async () => {
    const { context, requests } = harness({
      reads: [pullRequest('OPEN'), pullRequest('MERGED')],
      write: (url) => (url === MERGE_URL ? { status: 200, body: pullRequest('MERGED') } : undefined),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(
        mergeInput({ closeSourceBranch: true, mergeStrategy: 'fast_forward' }),
        context,
      ),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed merge must be applied');
    const write = requests.find((request) => request.url === MERGE_URL);
    expect(write?.method).toBe('POST');
    // `close_source_branch` travels because the caller decided it, and the strategy is the one they
    // chose — neither is defaulted here, and no fourth field is invented.
    expect(write?.body).toEqual({ close_source_branch: true, merge_strategy: 'fast_forward' });
    expect(writesTo(requests, MERGE_URL)).toBe(1);
  });

  it('never reports a queued merge as merged while the pull request still reads OPEN', async () => {
    const { context } = harness({
      reads: [pullRequest('OPEN')],
      write: (url) => (
        url === MERGE_URL
          ? { status: 202, headers: { location: `${PULL_REQUEST_URL}/merge/task-status/1` } }
          : undefined
      ),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    // The merge was accepted, not observed. `applied` here would be the UI telling someone their
    // branch landed while Bitbucket is still deciding whether it can.
    expect(settled.kind).toBe('pending');
  });

  it('refuses to act on a queued merge whose location is not a Bitbucket API location', async () => {
    const { context } = harness({
      reads: [pullRequest('OPEN')],
      write: (url) => (
        url === MERGE_URL
          ? { status: 202, headers: { location: 'https://merge-status.example.com/task/1' } }
          : undefined
      ),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    if (settled.kind !== 'unavailable') throw new Error('an untrusted location must not settle');
    expect(settled.failure.code).toContain('merge-status-location-untrusted');
  });

  it('reports a 409 merge refusal as its own terminal outcome rather than a generic failure', async () => {
    const { context, requests } = harness({
      reads: [pullRequest('OPEN')],
      write: (url) => (
        url === MERGE_URL
          ? { status: 409, body: { error: { message: 'merge conflict' } } }
          : undefined
      ),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    if (settled.kind !== 'rejected') throw new Error('409 is a terminal merge refusal');
    expect(settled.reason).toBe('provider-rejected');
    // A refused merge is reported, never repeated.
    expect(writesTo(requests, MERGE_URL)).toBe(1);
  });

  it('does not reconcile a response that proves Bitbucket rejected the write before applying it', async () => {
    const { context, requests } = harness({
      reads: [pullRequest('OPEN'), pullRequest('MERGED')],
      write: (url) => (
        url === MERGE_URL
          ? { status: 401, body: { error: { message: 'credential expired' } } }
          : undefined
      ),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    if (settled.kind !== 'unavailable') {
      throw new Error('an authentication refusal must not be reconciled as a possible merge');
    }
    expect(settled.failure.class).toBe('authentication');
    // A generic `failed => confirm` fix would consume the second, MERGED read and falsely report
    // this rejected request as applied. Only answer-loss failures earn the one exact confirmation.
    expect(requests.filter((request) => request.url === PULL_REQUEST_URL)).toHaveLength(1);
    expect(writesTo(requests, MERGE_URL)).toBe(1);
  });

  it('confirms an answer-lost merge once instead of returning unavailable or writing again', async () => {
    const { context, requests } = harness({
      reads: [pullRequest('OPEN'), pullRequest('MERGED')],
      write: (url) => (url === MERGE_URL ? { status: 502, body: { error: { message: 'gateway' } } } : undefined),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    expect(settled.kind).toBe('applied');
    expect(writesTo(requests, MERGE_URL)).toBe(1);
    expect(requests.filter((request) => request.url === PULL_REQUEST_URL)).toHaveLength(2);
  });

  it('confirms one transport-answer-lost merge without writing a second time', async () => {
    const { context, requests } = harness({
      reads: [pullRequest('OPEN'), pullRequest('MERGED')],
      write: (url) => (url === MERGE_URL ? { error: new Error('socket reset') } : undefined),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    expect(settled.kind).toBe('applied');
    expect(writesTo(requests, MERGE_URL)).toBe(1);
    expect(requests.filter((request) => request.url === PULL_REQUEST_URL)).toHaveLength(2);
  });

  it('stops after caller cancellation racing a dispatched merge and reports the outcome as uncertain', async () => {
    const caller = new AbortController();
    const { context, requests } = harness({
      reads: [pullRequest('OPEN'), pullRequest('MERGED')],
      signal: caller.signal,
      write: (url) => {
        if (url !== MERGE_URL) return undefined;
        caller.abort(new DOMException('The caller left the detail.', 'AbortError'));
        return { status: 200, body: pullRequest('MERGED') };
      },
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await mergeBitbucketPullRequestAction(mergeInput(), context),
    );

    // The command may have reached Bitbucket, but cancellation bars its confirming GET from being
    // sent. The Action therefore neither retries the merge nor claims that it applied.
    expect(settled.kind).toBe('uncertain');
    expect(writesTo(requests, MERGE_URL)).toBe(1);
    expect(requests.filter((request) => request.url === PULL_REQUEST_URL)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------- decline */

describe('Bitbucket pull-request decline', () => {
  it('declines an open pull request and proves the declined state with a fresh read', async () => {
    const { context, requests } = harness({
      reads: [pullRequest('OPEN'), pullRequest('DECLINED')],
      write: (url) => (
        url === DECLINE_URL ? { status: 200, body: pullRequest('DECLINED') } : undefined
      ),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await declineBitbucketPullRequestAction(declineInput(), context),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed decline must be applied');
    const write = requests.find((request) => request.url === DECLINE_URL);
    expect(write?.method).toBe('POST');
    // Bitbucket documents no body for this route, so none is sent rather than an invented reason.
    expect(write?.body).toBeUndefined();
  });

  it('refuses to decline a pull request that is already merged, with zero writes', async () => {
    const { context, requests } = harness({ reads: [pullRequest('MERGED')] });

    const settled = BitbucketMutationResultV1Schema.parse(
      await declineBitbucketPullRequestAction(declineInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('a merged pull request cannot be declined');
    expect(settled.reason).toBe('entry-not-open');
    expect(writesTo(requests, DECLINE_URL)).toBe(0);
  });

  it('confirms an answer-lost decline once instead of returning unavailable', async () => {
    const { context, requests } = harness({
      reads: [pullRequest('OPEN'), pullRequest('DECLINED')],
      write: (url) => (url === DECLINE_URL ? { status: 502, body: { error: { message: 'gateway' } } } : undefined),
    });

    const settled = BitbucketMutationResultV1Schema.parse(
      await declineBitbucketPullRequestAction(declineInput(), context),
    );

    expect(settled.kind).toBe('applied');
    expect(writesTo(requests, DECLINE_URL)).toBe(1);
  });
});

/* --------------------------------------------------------- comment resolution */

const COMMENT_ID = '9001';
const COMMENT_URL = `${PULL_REQUEST_URL}/comments/${COMMENT_ID}`;
const COMMENT_RESOLUTION_URL = `${COMMENT_URL}/resolve`;

function commentInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: LOCAL_REF,
    commentId: COMMENT_ID,
    ...overrides,
  };
}

/**
 * One Bitbucket comment, at whichever resolution the case needs.
 *
 * `unknown` OMITS the key entirely, because that is exactly what a deployment without comment
 * resolution returns — and the difference between an absent key and a null one is the whole
 * tri-state.
 */
function comment(
  resolution: 'resolved' | 'unresolved' | 'unknown',
): Readonly<Record<string, unknown>> {
  const base = {
    type: 'pullrequest_comment',
    id: Number(COMMENT_ID),
    content: { raw: 'Please rename this' },
    user: { uuid: VIEWER_UUID, nickname: 'reviewer' },
  };
  if (resolution === 'unknown') return base;
  return {
    ...base,
    resolution: resolution === 'resolved' ? { user: { nickname: 'reviewer' } } : null,
  };
}

/** A harness whose comment reads walk a scripted sequence, exactly as the entry harness does. */
function commentHarness(input: Readonly<{
  reads: readonly Readonly<Record<string, unknown>>[];
  write?: (method: string) => StubReply | undefined;
}>) {
  let read = 0;
  const { http, requests } = createHttpStub((url, request) => {
    if (url === COMMENT_RESOLUTION_URL) {
      return input.write?.(request?.method ?? 'GET') ?? { status: 200, body: {} };
    }
    if (url === COMMENT_URL) {
      const body = input.reads[Math.min(read, input.reads.length - 1)];
      read += 1;
      return { body };
    }
    if (url === PULL_REQUEST_URL) return { body: pullRequest('MERGED') };
    if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID, nickname: 'viewer' } };
    return undefined;
  });
  const { connectedAccounts } = createConnectedAccountsStub({
    accounts: [{ accountId: 'account-1' }],
  });
  return { context: createInvocationContext(connectedAccounts, http), requests };
}

describe('Bitbucket comment resolution', () => {
  it('resolves a thread with one POST and proves it from the comment itself', async () => {
    const { context, requests } = commentHarness({
      reads: [comment('unresolved'), comment('resolved')],
    });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await resolveBitbucketCommentAction(commentInput(), context),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed resolve must be applied');
    expect(settled.resolution).toBe('resolved');
    const write = requests.find((request) => request.url === COMMENT_RESOLUTION_URL);
    expect(write?.method).toBe('POST');
    // Bitbucket documents no request body for either direction, so none is sent.
    expect(write?.body).toBeUndefined();
    expect(writesTo(requests, COMMENT_RESOLUTION_URL)).toBe(1);
  });

  it('reopens a resolved thread with DELETE on that same path', async () => {
    const { context, requests } = commentHarness({
      reads: [comment('resolved'), comment('unresolved')],
    });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await unresolveBitbucketCommentAction(commentInput(), context),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed reopen must be applied');
    expect(settled.resolution).toBe('unresolved');
    const write = requests.find((request) => request.url === COMMENT_RESOLUTION_URL);
    // The verb IS the direction here. A POST would resolve the thread this call reopened.
    expect(write?.method).toBe('DELETE');
    expect(writesTo(requests, COMMENT_RESOLUTION_URL)).toBe(1);
  });

  it('never reads the pull request, so a thread on a merged one is still resolvable', async () => {
    const { context, requests } = commentHarness({
      reads: [comment('unresolved'), comment('resolved')],
    });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await resolveBitbucketCommentAction(commentInput(), context),
    );

    // Merge and decline are transitions of an OPEN pull request; resolving a review thread is not.
    // The harness answers MERGED for the entry, and this write neither asks nor cares — refusing
    // here would take away a capability Bitbucket has.
    expect(settled.kind).toBe('applied');
    expect(requests.filter((request) => request.url === PULL_REQUEST_URL)).toHaveLength(0);
  });

  it('writes nothing when the comment already reads the way it was asked to', async () => {
    const { context, requests } = commentHarness({ reads: [comment('resolved')] });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await resolveBitbucketCommentAction(commentInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('an already-resolved thread must refuse');
    expect(settled.reason).toBe('already-in-resolution');
    expect(settled.resolution).toBe('resolved');
    expect(writesTo(requests, COMMENT_RESOLUTION_URL)).toBe(0);
  });

  it('reports a write Bitbucket accepted and the comment does not show', async () => {
    const { context, requests } = commentHarness({
      reads: [comment('unresolved'), comment('unresolved')],
    });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await resolveBitbucketCommentAction(commentInput(), context),
    );

    // A `200` whose confirming read disagrees is not a resolve. Calling it applied is the quiet
    // failure this confirming read exists to catch.
    if (settled.kind !== 'rejected') throw new Error('an unconfirmed write must not be applied');
    expect(settled.reason).toBe('resolution-unconfirmed');
    expect(settled.resolution).toBe('unresolved');
    expect(writesTo(requests, COMMENT_RESOLUTION_URL)).toBe(1);
  });

  it('writes on a deployment that reports no resolution, and never calls it proven', async () => {
    const { context, requests } = commentHarness({
      reads: [comment('unknown'), comment('unknown')],
    });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await resolveBitbucketCommentAction(commentInput(), context),
    );

    // `unknown` is silence, not "already resolved", so the write IS sent — refusing would remove
    // the capability from every deployment this build cannot read resolution out of.
    expect(writesTo(requests, COMMENT_RESOLUTION_URL)).toBe(1);
    // And silence still cannot prove the effect.
    if (settled.kind !== 'rejected') throw new Error('an unprovable write must not be applied');
    expect(settled.reason).toBe('resolution-unconfirmed');
    expect(settled.resolution).toBe('unknown');
  });

  it('confirms an answer-lost comment resolution once instead of returning unavailable', async () => {
    const { context, requests } = commentHarness({
      reads: [comment('unresolved'), comment('resolved')],
      write: () => ({ status: 502, body: { error: { message: 'gateway' } } }),
    });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await resolveBitbucketCommentAction(commentInput(), context),
    );

    expect(settled.kind).toBe('applied');
    expect(writesTo(requests, COMMENT_RESOLUTION_URL)).toBe(1);
    expect(requests.filter((request) => request.url === COMMENT_URL)).toHaveLength(2);
  });

  it('refuses a comment id it could not have minted, before any request exists', async () => {
    const { context, requests } = commentHarness({ reads: [comment('unresolved')] });

    const settled = BitbucketCommentResolutionResultV1Schema.parse(
      await resolveBitbucketCommentAction(
        commentInput({ commentId: '1/resolve?x=../../other' }),
        context,
      ),
    );

    // The grammar is checked before the route exists, because the path this would build addresses
    // whatever that segment happens to encode.
    expect(settled.kind).toBe('unavailable');
    expect(requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ the gate */

describe('Bitbucket pull-request write declarations', () => {
  const declarations = Object.values(BITBUCKET_TRIAGE_MUTATION_ACTION_IDS).map((id) => {
    const declaration = PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === id);
    if (declaration === undefined) throw new Error(`${id} must be declared in the manifest`);
    return declaration;
  });

  it('keeps every write unreachable from any agent surface and behind a host confirmation', () => {
    for (const declaration of declarations) {
      // The human gate is reachability, not a prompt. A `danger` level plus an agent surface would
      // only floor an agent invocation to an approval prompt; omitting the surface means there is
      // no tool, no prompt and no exposure at all.
      expect(declaration.surfaces).toContain('ui');
      // `plugin` is REACHABILITY, and its absence is silent: a mounted plugin surface always
      // dispatches as a plugin caller, so `executeContributedAction` resolves `actionSurface` to
      // `plugin` and refuses anything that does not declare it. Without this line the whole write
      // is dead on arrival with a green suite.
      expect(declaration.surfaces).toContain('plugin');
      expect(declaration.surfaces).not.toContain('agent');
      expect(declaration.surfaces).not.toContain('mcp');
      expect(declaration.surfaces).not.toContain('cli');
      expect(declaration.dangerLevel).not.toBe('safe');
      expect(declaration.confirmation?.title).toBeTypeOf('string');
    }
  });

  it('binds every write to the network grant and to the exact configured account', () => {
    for (const declaration of declarations) {
      // A write Action declaring neither grant is a manifest defect rather than a runtime one: the
      // host revalidates origin and method at dispatch, so an undeclared verb never reaches
      // Bitbucket and no unit test below this line could see it.
      expect(declaration.hostAccess).toContain('bitbucket-api');
      expect(declaration.hostAccess).toContain(BITBUCKET_CONNECTED_ACCOUNT_PURPOSE);
      expect(declaration.connectedAccountPurposeBindings).toEqual([
        { path: 'instance.binding.account', purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE },
      ]);
    }
  });

  it('grants exactly the verbs its declared writes use, and no verb none consumes', () => {
    const network = PLUGIN_MANIFEST.hostAccess.required
      .find((entry) => entry.id === 'bitbucket-api');
    // `merge`, `decline` and resolving a comment thread are POSTs. `DELETE` is here for exactly
    // one Action: Bitbucket documents reopening a comment thread as `DELETE` on the resolve path,
    // so for that write the verb IS the effect. `PUT` stays absent — no declared Action uses it,
    // and a verb granted for symmetry is authority the user approved for nothing.
    expect(network?.scope).toMatchObject({ methods: ['GET', 'POST', 'DELETE'] });
  });
});
