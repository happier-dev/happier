/**
 * The GitLab mutation Action contracts.
 *
 * Six exact Actions, six strict input schemas, six strict result unions. There
 * is deliberately no `mutate({ operation, payload })` envelope and no shared
 * operation discriminant: `sources/SCM.md` §3.8 makes every externally visible
 * write its own named Action so a caller cannot reach a write the host never
 * admitted, and so each danger level, head-pin obligation and confirming read is
 * declared rather than computed.
 *
 * What they DO share is the refusal grammar, because the questions a user is
 * owed are the same for all of them: did anything happen, is the item still what
 * I read, and did GitLab prove the outcome. Those four arms are built once by
 * `defineGitlabMutationArms` and instantiated per re-observed row shape, which
 * is the opposite of an envelope — the success arm, and only the success arm, is
 * per-Action.
 *
 * The row shape differs by KIND rather than by Action, and it is not widened to
 * cover both: a merge request has a head commit, a draft flag and a scheduled
 * auto-merge, and an issue has none of the three. One row type carrying them as
 * optional members would let an issue answer report `draft: false` — a fact
 * about an entity that has no drafts.
 *
 * `sources/SCM.md` §2.8: **every mutation returns the re-observed entity, never
 * a bare boolean.** A boolean forces the caller into a second read, and that
 * second read is a second race.
 */

import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolUnion,
  defineProtocolUtf8String,
  type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import {
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { GITLAB_DETAIL_BOUNDS_V1 } from '../detail/projection.js';

const GitlabBooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

const IdentifierSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITLAB_DETAIL_BOUNDS_V1.identifierUtf8Bytes,
  minLength: 1,
});
const LabelSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITLAB_DETAIL_BOUNDS_V1.labelUtf8Bytes,
  minLength: 1,
});
const LocationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITLAB_DETAIL_BOUNDS_V1.locationUtf8Bytes,
  minLength: 1,
});
const TimestampSchema = defineProtocolNumber({ integer: true });

/**
 * The commit the user acted on.
 *
 * A full GitLab object id is 40 lowercase hex characters; the bound admits a
 * short id and tomorrow's longer hash without admitting a ref name, a branch or
 * a sentence. It is never derived here — `sources/SCM.md` §2.6 forbids filling
 * it from a fresh read at write time, which is the race the field exists to
 * close.
 *
 * The pattern is load-bearing rather than tidy. The value arrives as the mounted
 * observation's `nativeRevision`, and that one slot carries a merge request's
 * head commit but an issue's `updated_at`: an entry whose revision is a
 * timestamp is refused HERE, before it can be sent to GitLab as a `sha` that
 * GitLab would answer `400` to — or, if a later GitLab ignored it, merge
 * unconditionally against.
 */
export const GitlabObservedHeadShaV1Schema = defineProtocolUtf8String({
  maxUtf8Bytes: 64,
  minLength: 7,
  pattern: '^[0-9a-f]{7,64}$',
});

/**
 * The re-observed merge request every mutation answers with.
 *
 * It carries GitLab's own state word rather than a closed union: a state this
 * client has not heard of must not turn a merge that succeeded into a contract
 * failure. The Action decides its own arm from `state`/`mergedAtMs`; this row is
 * the evidence the user reads.
 */
export const GitlabMergeRequestStateRowV1Schema = defineProtocolObject({
  iid: IdentifierSchema,
  state: LabelSchema,
  draft: GitlabBooleanSchema,
  headSha: IdentifierSchema.optional(),
  /**
   * GitLab's `updated_at` on the re-observed item. It is EVIDENCE, not a gate:
   * §2.8 requires every mutation to answer with the re-observed entity, and this
   * is one of that entity's own facts. No pin is compared against it — the
   * conditional write these Actions perform is pinned to `headSha`.
   */
  revision: IdentifierSchema.optional(),
  mergedAtMs: TimestampSchema.optional(),
  webUrl: LocationSchema.optional(),
  /**
   * GitLab's cached, asynchronously recomputed mergeability projection. It is
   * published because `checking`, `approvals_syncing` and `ci_still_running` are
   * *unknown-retry* rather than *cannot merge* (`sources/SCM.md` §4.7.2), and a
   * reader that cannot see the word cannot tell the user which one it is.
   */
  detailedMergeStatus: LabelSchema.optional(),
  /**
   * GitLab merged nothing yet and will merge when its conditions are met — the
   * auto-merge and merge-train case. It is a different answer from `merged` to a
   * person waiting on a release, so it is never folded into one.
   */
  autoMergeScheduled: GitlabBooleanSchema,
}, { policy: 'closed' });
export type GitlabMergeRequestStateRowV1 =
  ReturnType<typeof GitlabMergeRequestStateRowV1Schema.parse>;

/**
 * The re-observed issue every issue mutation answers with.
 *
 * It is a separate row rather than the merge-request row with three optional
 * members, because an issue HAS no head commit, no draft flag and no scheduled
 * auto-merge — and a shape that could carry them would let a reader ask an issue
 * a question about merges.
 *
 * `revision` is GitLab's `updated_at`, and here it is not only evidence: an
 * issue has no head, so `sources/SCM.md` §4.7 makes this exact value the
 * currentness gate the issue Actions compare their caller's pin against.
 */
export const GitlabIssueStateRowV1Schema = defineProtocolObject({
  iid: IdentifierSchema,
  state: LabelSchema,
  revision: IdentifierSchema.optional(),
  closedAtMs: TimestampSchema.optional(),
  webUrl: LocationSchema.optional(),
}, { policy: 'closed' });
export type GitlabIssueStateRowV1 = ReturnType<typeof GitlabIssueStateRowV1Schema.parse>;

/**
 * Why a mutation did not reach its intended outcome.
 *
 * Each member is one documented provider answer or one preflight fact, never a
 * generic error: `sources/SCM.md` §4.7.2 records that GitLab's `405`, `409` and
 * `422` are three different things to a user, and collapsing them produces a
 * button whose only advice is "try again".
 */
export const GitlabMutationRefusalReasonV1Schema = defineProtocolUnion([
  /** The item is not in the state this Action transitions from. */
  defineProtocolLiteral('notOpen'),
  /** GitLab `405`: the merge request cannot merge. */
  defineProtocolLiteral('notMergeable'),
  /** GitLab `409`: the pinned head is no longer the source-branch head. */
  defineProtocolLiteral('headAdvanced'),
  /** GitLab `422`: the merge ran and failed. Not retryable without a human. */
  defineProtocolLiteral('mergeAttemptFailed'),
  /** GitLab `400`: the merge required a SHA it did not receive. */
  defineProtocolLiteral('shaRequired'),
  /** A GraphQL mutation answered `200` and carried errors instead of an effect. */
  defineProtocolLiteral('mutationRejected'),
  /**
   * GitLab merged this merge request, and a merged merge request has no reopen
   * transition at all.
   *
   * It is its own member rather than `notOpen` because the two are different
   * advice: `notOpen` describes a state this Action does not transition FROM and
   * a later read may change, while this one describes a terminal fact about the
   * entity. Collapsing them tells a user to wait for something that will never
   * happen.
   */
  defineProtocolLiteral('notReopenable'),
]);
export type GitlabMutationRefusalReasonV1 =
  ReturnType<typeof GitlabMutationRefusalReasonV1Schema.parse>;

const ProviderMessageSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITLAB_DETAIL_BOUNDS_V1.labelUtf8Bytes,
  minLength: 1,
});

/**
 * The four arms every GitLab mutation shares, instantiated for one re-observed
 * row shape.
 *
 * One owner, two instantiations. The alternative — writing the arms out again
 * beside the issue row — is the split brain this factory exists to prevent: the
 * copies start identical, and the one that later gains a refusal member or loses
 * an `observed` is the one a reader trusts.
 */
function defineGitlabMutationArms<TRowInput, TRowOutput>(
  rowSchema: ProtocolComposableSchema<TRowInput, TRowOutput>,
) {
  return [
    /**
     * The item moved under the user between the read they acted on and this
     * invocation, and **no write was performed**.
     *
     * `sources/SCM.md` §2.6: never write on the user's behalf against changed
     * state, and never silently skip the write — silently doing nothing is the
     * worst outcome, because the user believes they merged.
     */
    defineProtocolObject({
      kind: defineProtocolLiteral('reconfirmationRequired'),
      observed: rowSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
      kind: defineProtocolLiteral('refused'),
      reason: GitlabMutationRefusalReasonV1Schema,
      /**
       * Whether the write left this process. `false` is a preflight refusal and
       * nothing reached GitLab; `true` means GitLab received the request and
       * answered that it performed no transition.
       */
      dispatched: GitlabBooleanSchema,
      /** Present when the item could be re-observed after the refusal. */
      observed: rowSchema.optional(),
      /** GitLab's own bounded explanation, when it supplied one. */
      messages: defineProtocolArray(ProviderMessageSchema, { maxItems: 8 }).optional(),
    }, { policy: 'closed' }),
    /**
     * The write was dispatched and its outcome is **not proven**.
     *
     * This arm always means a request reached GitLab. It exists so a confirming
     * read that could not settle never becomes a success claim, and never becomes
     * a plain failure either — a user told "it failed" about a merge that may
     * have landed is being misinformed about production.
     */
    defineProtocolObject({
      kind: defineProtocolLiteral('unconfirmed'),
      /** The re-observation, when one could be made and it proved nothing. */
      observed: rowSchema.optional(),
      /** Why the confirming read could not settle, when that is what happened. */
      failure: TriageSourceFailureV1Schema.optional(),
    }, { policy: 'closed' }),
    /** Nothing was attempted: admission, authorization or the currentness read failed. */
    defineProtocolObject({
      kind: defineProtocolLiteral('unavailable'),
      failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
  ] as const;
}

const SHARED_MUTATION_ARMS = defineGitlabMutationArms(GitlabMergeRequestStateRowV1Schema);
const SHARED_ISSUE_MUTATION_ARMS = defineGitlabMutationArms(GitlabIssueStateRowV1Schema);

/* ----------------------------------------------------------------- merge */

/**
 * `gitlab/merge-request/merge`.
 *
 * The head pin is **required**, and it is the caller's observed value: GitLab's
 * merge endpoint takes `sha` as its own precondition, so the pin is consumed as
 * a provider-native conditional write rather than as a client-side compare.
 *
 * No squash, commit-message or source-branch-removal member is declared. GitLab
 * exposes them, but this Action offers exactly one effect — the merge — and the
 * project's own configured defaults decide the rest. A branch-removal input
 * would be authority to delete a collaborator's later push that the user did not
 * grant here.
 *
 * The head pin is the ONLY precondition, and it is the strong one: it is checked
 * by GitLab itself rather than by a client-side compare, so it cannot be lost to
 * the gap between this process's read and GitLab's write.
 */
export const GitlabMergeRequestMergeInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  observedHeadSha: GitlabObservedHeadShaV1Schema,
}, { policy: 'closed' });
export type GitlabMergeRequestMergeInputV1 =
  ReturnType<typeof GitlabMergeRequestMergeInputV1Schema.parse>;

export const GitlabMergeRequestMergeResultV1Schema = defineProtocolUnion([
  /** A confirming read proved `merged`. This is the only claim that it merged. */
  defineProtocolObject({
    kind: defineProtocolLiteral('merged'),
    item: GitlabMergeRequestStateRowV1Schema,
  }, { policy: 'closed' }),
  /**
   * GitLab accepted the request and will merge later — auto-merge, or a merge
   * train. `sources/SCM.md` §4.7.2: this is reported distinctly from `merged`.
   */
  defineProtocolObject({
    kind: defineProtocolLiteral('scheduled'),
    item: GitlabMergeRequestStateRowV1Schema,
  }, { policy: 'closed' }),
  ...SHARED_MUTATION_ARMS,
]);
export type GitlabMergeRequestMergeResultV1 =
  ReturnType<typeof GitlabMergeRequestMergeResultV1Schema.parse>;

/* ------------------------------------------------------------ mark ready */

/**
 * `gitlab/merge-request/mark-ready`.
 *
 * The head pin is required because the draft→ready transition fans a
 * notification out to every named reviewer, and that fan-out **is** the write:
 * it summons humans to review a specific commit set (`sources/SCM.md` §2.6).
 *
 * GraphQL `mergeRequestSetDraft` takes no provider-side precondition, so unlike
 * the merge this pin is compared in the preflight. That is the §2.6 fallback
 * spelled out — where no native precondition exists, re-read and refuse — not a
 * weaker guarantee smuggled in under the same field name.
 */
export const GitlabMergeRequestMarkReadyInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  observedHeadSha: GitlabObservedHeadShaV1Schema,
}, { policy: 'closed' });
export type GitlabMergeRequestMarkReadyInputV1 =
  ReturnType<typeof GitlabMergeRequestMarkReadyInputV1Schema.parse>;

export const GitlabMergeRequestMarkReadyResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('ready'),
    item: GitlabMergeRequestStateRowV1Schema,
  }, { policy: 'closed' }),
  ...SHARED_MUTATION_ARMS,
]);
export type GitlabMergeRequestMarkReadyResultV1 =
  ReturnType<typeof GitlabMergeRequestMarkReadyResultV1Schema.parse>;

/* ----------------------------------------------------------------- close */

/**
 * `gitlab/merge-request/close`.
 *
 * **No pin at all**, and that is `sources/SCM.md` §2.6's own row for this
 * operation: closing is head-independent, so a pin here would add a failure mode
 * protecting no invariant — a collaborator's push would refuse a close that
 * nothing invalidated. The currentness gate that remains is the one that matches
 * what close means: the shared preflight rereads the merge request and refuses
 * `notOpen` when GitLab no longer reports it open.
 *
 * Nothing else is declared either. GitLab exposes `should_remove_source_branch`
 * on this update; carrying it would take authority to delete a collaborator's
 * branch that this control never asked for.
 */
export const GitlabMergeRequestCloseInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
}, { policy: 'closed' });
export type GitlabMergeRequestCloseInputV1 =
  ReturnType<typeof GitlabMergeRequestCloseInputV1Schema.parse>;

export const GitlabMergeRequestCloseResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('closed'),
    item: GitlabMergeRequestStateRowV1Schema,
  }, { policy: 'closed' }),
  ...SHARED_MUTATION_ARMS,
]);
export type GitlabMergeRequestCloseResultV1 =
  ReturnType<typeof GitlabMergeRequestCloseResultV1Schema.parse>;

/* ---------------------------------------------------------------- reopen */

/**
 * `gitlab/merge-request/reopen`.
 *
 * **No pin**, matching `sources/SCM.md` §3.8's reopen row: reopening is
 * head-independent, so a pin here would refuse a reopen that a collaborator's
 * unrelated push had not invalidated. The gate that remains is the one reopen
 * actually asks — the shared preflight rereads the merge request, and a MERGED
 * merge request is refused `notReopenable` because GitLab has no such transition
 * for it.
 *
 * Nothing else is declared. GitLab's update also accepts `title`,
 * `description`, `target_branch` and `should_remove_source_branch`, and sending
 * any of them would overwrite an edit this control never asked to touch.
 */
export const GitlabMergeRequestReopenInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
}, { policy: 'closed' });
export type GitlabMergeRequestReopenInputV1 =
  ReturnType<typeof GitlabMergeRequestReopenInputV1Schema.parse>;

export const GitlabMergeRequestReopenResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('reopened'),
    item: GitlabMergeRequestStateRowV1Schema,
  }, { policy: 'closed' }),
  ...SHARED_MUTATION_ARMS,
]);
export type GitlabMergeRequestReopenResultV1 =
  ReturnType<typeof GitlabMergeRequestReopenResultV1Schema.parse>;

/* ----------------------------------------------------------------- issues */

/**
 * The currentness pin every GitLab issue Action carries.
 *
 * An issue has no head commit, so `sources/SCM.md` §4.7 makes the user-observed
 * `nativeRevision` — GitLab's own `updated_at` byte — the currentness gate. It is
 * compared for EQUALITY against the value a fresh read returns, so it is
 * deliberately admitted unparsed: parsing it into an instant would make two
 * spellings of one timestamp compare equal and quietly widen the gate.
 *
 * Unlike the merge pin, it is not a provider-side precondition — GitLab's issue
 * update accepts none — so it is `sources/SCM.md` §2.6's stated fallback: read,
 * compare, refuse before writing.
 */
export const GitlabObservedIssueRevisionV1Schema = IdentifierSchema;

const GitlabIssueMutationInputFields = {
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  observedRevision: GitlabObservedIssueRevisionV1Schema,
} as const;

/**
 * `gitlab/issue/close`.
 *
 * GitLab expresses the transition as `state_event` on the ordinary issue update,
 * which is a provider-native transition rather than a replacement of the issue's
 * fields: nothing else is sent, so a concurrent label, assignee or description
 * edit cannot be overwritten by this Action. No `labels`, `assignee_ids` or
 * `state_reason` member is declared for exactly that reason.
 */
export const GitlabIssueCloseInputV1Schema = defineProtocolObject(
  GitlabIssueMutationInputFields,
  { policy: 'closed' },
);
export type GitlabIssueCloseInputV1 = ReturnType<typeof GitlabIssueCloseInputV1Schema.parse>;

export const GitlabIssueCloseResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('closed'),
    item: GitlabIssueStateRowV1Schema,
  }, { policy: 'closed' }),
  ...SHARED_ISSUE_MUTATION_ARMS,
]);
export type GitlabIssueCloseResultV1 = ReturnType<typeof GitlabIssueCloseResultV1Schema.parse>;

/** `gitlab/issue/reopen`. The same transition endpoint, the other direction. */
export const GitlabIssueReopenInputV1Schema = defineProtocolObject(
  GitlabIssueMutationInputFields,
  { policy: 'closed' },
);
export type GitlabIssueReopenInputV1 = ReturnType<typeof GitlabIssueReopenInputV1Schema.parse>;

export const GitlabIssueReopenResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('reopened'),
    item: GitlabIssueStateRowV1Schema,
  }, { policy: 'closed' }),
  ...SHARED_ISSUE_MUTATION_ARMS,
]);
export type GitlabIssueReopenResultV1 = ReturnType<typeof GitlabIssueReopenResultV1Schema.parse>;
