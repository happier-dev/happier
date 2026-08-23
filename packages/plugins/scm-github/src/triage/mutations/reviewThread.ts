import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { GithubGetDependenciesV1 } from '../get.js';
import type { GithubRepositoryRouteV1 } from '../locator.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';

import type { GithubObservedReviewThreadV1 } from './contracts.js';
import { sendGithubGraphqlRequest } from './graphql.js';

/**
 * Resolving and reopening one line-anchored review thread.
 *
 * A review thread is a GraphQL-only entity — GitHub publishes no REST route that
 * addresses one — so this write runs the same three beats every other write in
 * this vertical runs, with GraphQL as the transport for all three: reread the
 * thread, decide, then mutate and confirm.
 *
 * THE READ IS THE IDENTITY PROOF, not an optimization. A thread node id is
 * opaque and GLOBAL: it names a thread anywhere the rebound account can reach,
 * so an implementation that mutated the caller's id directly would let a wrong
 * or stale id resolve a conversation in a repository the user is not even
 * looking at, and report success for it. The read answers which pull request and
 * which repository the thread actually belongs to, and this module refuses
 * before writing when that is not the admitted entry.
 *
 * The mutation's own `thread { isResolved }` payload is NOT the claim. It
 * describes the request GitHub accepted; the confirming read describes the
 * thread. That distinction is the same one every other write here makes, and it
 * is why an accepted mutation whose confirming read still disagrees settles as
 * `uncertain` rather than as success — and is never retried, because a retry
 * would re-decide on the user's behalf against state they never saw.
 */

export type GithubReviewThreadDependenciesV1 = GithubGetDependenciesV1;

const THREAD_ABSENT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_review_thread_absent',
});

/**
 * The thread exists and belongs to somebody else's conversation. It is a stated
 * failure rather than a refusal: a refusal hands back the entity the user should
 * re-decide against, and there is none when the request named the wrong one.
 */
const THREAD_NOT_ON_ENTRY_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_review_thread_not_on_entry',
});

const THREAD_RESPONSE_INVALID_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_review_thread_response_invalid',
});

type Applied = Readonly<{
  kind: 'applied';
  effect: 'changed' | 'alreadySatisfied';
  thread: GithubObservedReviewThreadV1;
}>;
type Uncertain = Readonly<{
  kind: 'uncertain';
  thread?: GithubObservedReviewThreadV1;
  failure?: TriageSourceFailureV1;
}>;
type Failed = Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>;

export type GithubReviewThreadResolutionOutcomeV1 = Applied | Uncertain | Failed;

/**
 * The one read. It asks for the resolution state AND the owning entry in a
 * single request, because "is it resolved" and "is it yours" are answers about
 * the same node and reading them separately would let the two disagree.
 */
const REVIEW_THREAD_QUERY = `query GithubReviewThread($threadId: ID!) {
  node(id: $threadId) {
    __typename
    ... on PullRequestReviewThread {
      id
      isResolved
      pullRequest {
        number
        repository {
          name
          owner { login }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation GithubResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

const UNRESOLVE_THREAD_MUTATION = `mutation GithubUnresolveReviewThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One read thread, reduced to the two facts a write decision needs. */
type ReadThread = Readonly<{
  thread: GithubObservedReviewThreadV1;
  /** The entry the thread actually hangs on, in GitHub's own casing. */
  owner: string;
  repository: string;
  entryNumber: string;
}>;

/**
 * Decodes one `node(id:)` answer. Anything that is not a populated review thread
 * yields `null` rather than a partially defaulted one: a thread whose owning
 * entry could not be read cannot be proved to be the admitted entry, and
 * defaulting either half would prove it falsely.
 */
function decodeReviewThread(data: Readonly<Record<string, unknown>>): ReadThread | null {
  const node = data.node;
  if (!isRecord(node) || node.__typename !== 'PullRequestReviewThread') return null;
  const id = typeof node.id === 'string' ? node.id.trim() : '';
  if (!id || typeof node.isResolved !== 'boolean') return null;

  const pullRequest = node.pullRequest;
  if (!isRecord(pullRequest) || typeof pullRequest.number !== 'number') return null;
  const repository = pullRequest.repository;
  if (!isRecord(repository) || typeof repository.name !== 'string') return null;
  const owner = repository.owner;
  if (!isRecord(owner) || typeof owner.login !== 'string') return null;

  return Object.freeze({
    thread: Object.freeze({ id, isResolved: node.isResolved }),
    owner: owner.login,
    repository: repository.name,
    entryNumber: String(pullRequest.number),
  });
}

type ThreadRead =
  | Readonly<{ ok: true; read: ReadThread }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

async function readGithubReviewThread(
  threadId: string,
  dependencies: GithubReviewThreadDependenciesV1,
): Promise<ThreadRead> {
  const answered = await sendGithubGraphqlRequest(
    { query: REVIEW_THREAD_QUERY, variables: { threadId } },
    dependencies,
  );
  if (!answered.ok) return Object.freeze({ ok: false as const, failure: answered.failure });

  const read = decodeReviewThread(answered.data);
  // A `node` GitHub answered as `null`, or as some other type, is a thread this
  // Action cannot act on at all — which is a different statement from a provider
  // error, and it is made without writing anything. A node that IS a review
  // thread but did not decode is the other statement: GitHub answered in a shape
  // this source cannot read, and saying "absent" about it would be a claim about
  // a thread that exists.
  if (read === null) {
    const node = answered.data.node;
    const threadShaped = isRecord(node) && node.__typename === 'PullRequestReviewThread';
    return Object.freeze({
      ok: false as const,
      failure: threadShaped ? THREAD_RESPONSE_INVALID_FAILURE : THREAD_ABSENT_FAILURE,
    });
  }
  return Object.freeze({ ok: true as const, read });
}

/**
 * Whether the thread GitHub answered with hangs on the entry this invocation was
 * admitted for.
 *
 * Owner and repository are compared case-insensitively because GitHub answers in
 * its own canonical casing while the routing token is lowercased, and a
 * case-sensitive comparison would refuse every legitimate thread. The entry
 * number is compared as the exact digits the local ref carries.
 */
function belongsToEntry(
  read: ReadThread,
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
): boolean {
  return read.owner.toLowerCase() === route.owner.toLowerCase()
    && read.repository.toLowerCase() === route.name.toLowerCase()
    && read.entryNumber === localRef.entryId;
}

/**
 * Converges one review thread on the requested resolution state.
 *
 * Both directions are dispatched through GitHub's own named mutations —
 * `resolveReviewThread` and `unresolveReviewThread` — because there is no field
 * to patch: sending the wrong one would report success for the opposite of what
 * the user asked.
 */
export async function setGithubReviewThreadResolution(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    threadId: string;
    /** The state the caller wants the thread to hold. Never a verb. */
    resolved: boolean;
  }>,
  dependencies: GithubReviewThreadDependenciesV1,
): Promise<GithubReviewThreadResolutionOutcomeV1> {
  const current = await readGithubReviewThread(input.threadId, dependencies);
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });

  if (!belongsToEntry(current.read, input.localRef, input.route)) {
    return Object.freeze({ kind: 'failed' as const, failure: THREAD_NOT_ON_ENTRY_FAILURE });
  }

  // Already there, so nothing is sent. Resolving a resolved thread is not free:
  // GitHub records a fresh resolution event on it, which reads to everyone
  // watching as a decision somebody just made.
  if (current.read.thread.isResolved === input.resolved) {
    return Object.freeze({
      kind: 'applied' as const,
      effect: 'alreadySatisfied' as const,
      thread: current.read.thread,
    });
  }

  const written = await sendGithubGraphqlRequest({
    query: input.resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION,
    variables: { threadId: input.threadId },
  }, dependencies);
  if (!written.ok) return Object.freeze({ kind: 'failed' as const, failure: written.failure });

  const confirmed = await readGithubReviewThread(input.threadId, dependencies);
  if (!confirmed.ok) {
    return Object.freeze({ kind: 'uncertain' as const, failure: confirmed.failure });
  }
  return confirmed.read.thread.isResolved === input.resolved
    ? Object.freeze({
      kind: 'applied' as const,
      effect: 'changed' as const,
      thread: confirmed.read.thread,
    })
    : Object.freeze({ kind: 'uncertain' as const, thread: confirmed.read.thread });
}
