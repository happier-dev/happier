/**
 * The source-neutral model behind a source's own Triage Settings page.
 *
 * It reads three published contracts and nothing else: the source's own
 * `listInstances` result, the target-owned caller-scoped configured-instance
 * read, and the target-owned source-administration result. It holds no provider
 * knowledge, no account catalogue, no configured-instance store, and no source
 * id — a second source using the same shapes reaches the same conclusions from
 * the same bytes.
 *
 * Both results are parsed through their published schemas rather than read off
 * an `unknown`, because a settings page is the one surface where a misread
 * means the user configures something other than what they chose. A result that
 * does not admit is reported as unreadable, never rendered around.
 *
 * It also owns what a row may claim about itself. A row's standing lifecycle is
 * the target's own answer to the caller-scoped configured-instance read, so it
 * survives a remount; on top of that a row advances only on a success arm the
 * target actually returned for a press made here. A page that inferred
 * "configured" from a failed or unknown outcome would offer Remove for a row
 * that was never created, and a page that trusted a refused press over the read
 * would hide a row the target says exists.
 */

import type { PluginActionExecution, PluginTranslate } from '@happier-dev/plugin-ui';
import {
  TriageListInstancesResultV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSourceAdministrationActionResultV1Schema,
  type TriageConfiguredSourceInstanceRecordV1,
  type TriageSourceAccountBindingV1,
  type TriageSourceFailureV1,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * The one spelling of the product this page configures a source into. Every
 * sentence below composes it, so the six source Settings pages cannot drift
 * into six names for one product.
 */
const PRODUCT_NAME = 'PRs & Issues';

/** One discovery candidate, projected for presentation and stable row identity. */
export type TriageSourceSettingsCandidateV1 = Readonly<{
  /**
   * The exact match tuple this candidate would configure, rendered for a row
   * key. It is presentation-local: it is never sent anywhere, and the target
   * derives its own private identity from the same components.
   */
  key: string;
  draft: TriageSourceInstanceDraftV1;
  label: string;
  path: string | null;
  accountId: string;
  /**
   * A `locatorDerived` key follows the provider's own display value, so the
   * same scope renamed upstream becomes a different configured instance. The
   * page says so rather than letting the user discover it after a rename.
   */
  keyFollowsProviderName: boolean;
}>;

/** One exact-binding discovery failure, projected beside the candidates it concerns. */
export type TriageSourceSettingsDiscoveryFailureV1 = Readonly<{
  key: string;
  accountId: string;
  localInstanceKey: string | null;
  failure: TriageSourceFailureV1;
}>;

/**
 * What the page currently knows about discovery.
 *
 * `listed` is the only state that renders rows, and it carries `complete`
 * explicitly: an incomplete enumeration renders its rows AND says the list may
 * be missing accounts, because silently showing a short list is how a user
 * concludes an account is gone.
 */
export type TriageSourceSettingsDiscoveryV1 =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'unreachable'; failure: TriageSourceFailureV1 | null; message: string | null }>
  | Readonly<{ kind: 'outcomeUnknown' }>
  | Readonly<{
    kind: 'listed';
    complete: boolean;
    candidates: readonly TriageSourceSettingsCandidateV1[];
    failures: readonly TriageSourceSettingsDiscoveryFailureV1[];
    /** A bounded-enumeration failure that covers the listing as a whole. */
    listingFailure: TriageSourceFailureV1 | null;
  }>;

/**
 * One configured instance the target says this source owns, projected onto the
 * same row key its discovery candidate would take.
 *
 * `lifecycle` is the whole reason the read exists: `active` admits Update and
 * Remove, `retired` admits Restore, and neither is reachable from a page that
 * can only remember the presses it made itself.
 */
export type TriageSourceSettingsConfiguredInstanceV1 = Readonly<{
  key: string;
  sourceInstanceId: string;
  lifecycle: 'active' | 'retired';
  /** The stored display label, falling back to the source's own instance key. */
  label: string;
  /** The stored provider location, falling back to the account it binds. */
  locator: string;
}>;

/**
 * What the page knows about the instances it has already configured.
 *
 * `read` is the only state that seeds a row, and it carries `complete`
 * explicitly for the same reason discovery does: the read is bounded, retired
 * rows are never deleted, and a page that presented a truncated answer as the
 * whole set would offer Add for something already configured without saying so.
 *
 * The two refusals stay apart because they are opposite sentences.
 * `sourceNotAdmitted` says this source is no longer an admitted source at all;
 * `raced` says ask again. Every other state means the page could not learn what
 * is configured — which it must SAY, because silently falling back to Add is how
 * a user is told their configured source is gone.
 */
export type TriageSourceSettingsConfiguredV1 =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'unreachable'; message: string }>
  | Readonly<{ kind: 'outcomeUnknown' }>
  | Readonly<{ kind: 'sourceNotAdmitted' }>
  | Readonly<{ kind: 'raced' }>
  | Readonly<{
    kind: 'read';
    complete: boolean;
    instances: readonly TriageSourceSettingsConfiguredInstanceV1[];
  }>;

function projectConfiguredInstance(
  record: TriageConfiguredSourceInstanceRecordV1,
): TriageSourceSettingsConfiguredInstanceV1 {
  const { configured } = record;
  return {
    key: instanceKey(configured.binding, configured.localInstanceKey),
    sourceInstanceId: configured.instance.sourceInstanceId,
    lifecycle: record.lifecycle,
    // A stored locator is optional on the configured record, and the source's
    // own instance key is the only other thing in it a person can recognize.
    label: configured.locator?.displayLabel ?? configured.localInstanceKey,
    locator: configured.locator?.displayPath ?? configured.binding.account.accountId,
  };
}

/**
 * Reads the target-owned caller-scoped configured-instance read into the page's
 * standing knowledge of its own rows.
 *
 * This is what makes configuration reversible across a remount. Without it the
 * page starts every mount knowing nothing, so Update, Remove and Restore — the
 * three administration arms that name an exact row — are unreachable for
 * anything the user did not configure in this same visit.
 */
export function readTriageSourceConfiguredInstances(
  execution: PluginActionExecution<unknown>,
): TriageSourceSettingsConfiguredV1 {
  if (execution.status === 'idle' || execution.status === 'pending') return { kind: 'loading' };
  if (execution.status === 'outcomeUnknown') return { kind: 'outcomeUnknown' };
  if (execution.status === 'error') return { kind: 'unreachable', message: execution.message };

  const parsed = TriageReadConfiguredSourceInstancesResultV1Schema.safeParse(execution.result);
  if (!parsed.success) return { kind: 'unreadable' };
  const result = parsed.data;
  if (result.kind === 'invalidCaller') return { kind: 'sourceNotAdmitted' };
  if (result.kind === 'currentnessConflict') return { kind: 'raced' };

  return {
    kind: 'read',
    complete: result.status === 'complete',
    instances: result.instances.map(projectConfiguredInstance),
  };
}

/**
 * What the target said about one administration attempt.
 *
 * Every arm of the published administration result has a member here, including
 * the four failure arms, because a settings page that collapses `invalidCaller`
 * into "something went wrong" removes the only signal that the source
 * contribution itself is no longer admitted. The four success arms that carry
 * an id stay apart because each one is a different sentence for the user: a row
 * that was created reads differently from one that already existed, one whose
 * configuration was replaced, and one that was brought back.
 */
export type TriageSourceSettingsConfigurationV1 =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'submitting' }>
  | Readonly<{ kind: 'configured'; sourceInstanceId: string }>
  | Readonly<{ kind: 'alreadyConfigured'; sourceInstanceId: string }>
  | Readonly<{ kind: 'reconfigured'; sourceInstanceId: string }>
  | Readonly<{ kind: 'restored'; sourceInstanceId: string }>
  | Readonly<{ kind: 'removed'; sourceInstanceId: string }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'atMaximum' }>
  | Readonly<{ kind: 'sourceNotAdmitted' }>
  | Readonly<{ kind: 'raced' }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'failed'; message: string; retryable: boolean }>
  | Readonly<{ kind: 'outcomeUnknown'; message: string }>;

/**
 * What this page knows about one row's durable configured instance.
 *
 * `unknown` is the honest state for a row the target named in neither the
 * configured read nor an administration arm invoked here. It never means "not
 * configured" — a read that could not be completed leaves every row unknown —
 * which is exactly why an `unknown` row offers Add and says nothing else about
 * its state.
 */
export type TriageSourceSettingsRowLifecycleV1 =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'configured'; sourceInstanceId: string }>
  | Readonly<{ kind: 'retired'; sourceInstanceId: string }>;

/** The starting lifecycle for a row nothing has been invoked against. */
export const UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1: TriageSourceSettingsRowLifecycleV1 =
  Object.freeze({ kind: 'unknown' });

export type TriageSourceSettingsRowToneV1 = 'neutral' | 'success' | 'warning' | 'danger';

/** One control a row offers, already named for both sight and assistive technology. */
export type TriageSourceSettingsRowControlV1 = Readonly<{
  id: 'add' | 'restore' | 'reconfigure' | 'remove';
  label: string;
  accessibilityLabel: string;
  variant: 'primary' | 'secondary';
}>;

/**
 * What one row is about, and how this source's current listing accounts for it.
 *
 * `discovered` carries the fresh draft every arm but `remove` requires. The other
 * two are a configured instance the listing did not produce a candidate for, and
 * they are kept apart because absence is only evidence when the listing was
 * complete: `missing` means this source genuinely cannot see it any more, while
 * `unlisted` means the listing itself did not finish, so the instance may be
 * perfectly healthy. Telling a user to remove a working source is the mistake
 * that distinction prevents.
 */
type TriageSourceSettingsRowSubjectV1 = Readonly<{
  key: string;
  label: string;
  /** The provider location, or the account when the provider gave no path. */
  locator: string;
  keyFollowsProviderName: boolean;
}> & (
  | Readonly<{ presence: 'discovered'; draft: TriageSourceInstanceDraftV1 }>
  | Readonly<{ presence: 'missing' | 'unlisted' }>
);

/** Everything a row renders, derived once so six pages cannot disagree. */
export type TriageSourceSettingsRowV1 = Readonly<{
  key: string;
  title: string;
  /** The row's one state sentence, or `null` when nothing true can be said yet. */
  status: string | null;
  /** The provider location, omitted when it only repeats the title. */
  locator: string | null;
  tone: TriageSourceSettingsRowToneV1;
  controls: readonly TriageSourceSettingsRowControlV1[];
  /** Present only once the target has told this page the row's stable id. */
  sourceInstanceId: string | null;
  /**
   * The freshly discovered draft this row's arms submit, or `null` when this
   * source's listing no longer produces one. Every arm except `remove` carries a
   * draft, so a row without one is offered no other arm.
   */
  draft: TriageSourceInstanceDraftV1 | null;
  keyFollowsProviderName: boolean;
}>;

/**
 * A presentation-local separator. It is a printable character no component of
 * the tuple can contain, so the key cannot be forged by a provider value.
 */
const KEY_SEPARATOR = ' › ';

/**
 * The presentation row key, built from the same closed scalar leaves the target
 * uses for its own private identity, in the same order. Building it from a
 * different projection is how two rows for one instance appear.
 *
 * It is the ONE key both published reads are projected through: a freshly
 * discovered candidate and the configured instance the target already holds for
 * that same tuple must land on the same row, or the page would offer Add beside
 * a row it already configured.
 */
function instanceKey(
  binding: TriageSourceAccountBindingV1,
  localInstanceKey: string,
): string {
  return [
    binding.purpose,
    binding.account.service.pluginId,
    binding.account.service.localId,
    binding.account.accountId,
    localInstanceKey,
  ].join(KEY_SEPARATOR);
}

function projectCandidate(draft: TriageSourceInstanceDraftV1): TriageSourceSettingsCandidateV1 {
  return {
    key: instanceKey(draft.binding, draft.localInstanceKey),
    draft,
    label: draft.locator.displayLabel,
    path: draft.locator.displayPath ?? null,
    accountId: draft.binding.account.accountId,
    keyFollowsProviderName: draft.keyStability === 'locatorDerived',
  };
}

/**
 * Reads the source's own `listInstances` execution into the page's discovery
 * state.
 *
 * A dispatch that never settled is `outcomeUnknown` rather than an error: the
 * read may still be running against the provider, and a page that renders it as
 * a failure invites a second provider read the user did not ask for.
 */
export function readTriageSourceDiscovery(
  execution: PluginActionExecution<unknown>,
): TriageSourceSettingsDiscoveryV1 {
  if (execution.status === 'idle' || execution.status === 'pending') return { kind: 'loading' };
  if (execution.status === 'outcomeUnknown') return { kind: 'outcomeUnknown' };
  if (execution.status === 'error') {
    return { kind: 'unreachable', failure: null, message: execution.message };
  }

  const parsed = TriageListInstancesResultV1Schema.safeParse(execution.result);
  if (!parsed.success) return { kind: 'unreadable' };
  const result = parsed.data;
  if (result.kind === 'failed') {
    return { kind: 'unreachable', failure: result.failure, message: null };
  }

  return {
    kind: 'listed',
    complete: result.kind === 'complete',
    candidates: result.candidates.map(projectCandidate),
    failures: result.failures.map((entry, index) => ({
      key: [String(index), entry.binding.account.accountId, entry.localInstanceKey ?? ''].join(KEY_SEPARATOR),
      accountId: entry.binding.account.accountId,
      localInstanceKey: entry.localInstanceKey ?? null,
      failure: entry.failure,
    })),
    listingFailure: result.kind === 'incomplete' ? result.failure ?? null : null,
  };
}

/** Reads one target-owned administration execution into the page's per-row state. */
export function readTriageSourceConfiguration(
  execution: PluginActionExecution<unknown>,
): TriageSourceSettingsConfigurationV1 {
  if (execution.status === 'idle') return { kind: 'idle' };
  if (execution.status === 'pending') return { kind: 'submitting' };
  if (execution.status === 'outcomeUnknown') {
    return { kind: 'outcomeUnknown', message: execution.message };
  }
  if (execution.status === 'error') {
    return { kind: 'failed', message: execution.message, retryable: execution.retryable };
  }

  const parsed = TriageSourceAdministrationActionResultV1Schema.safeParse(execution.result);
  if (!parsed.success) return { kind: 'unreadable' };
  const result = parsed.data;
  switch (result.kind) {
    case 'active':
      return { kind: 'configured', sourceInstanceId: result.sourceInstanceId };
    case 'reused':
      return { kind: 'alreadyConfigured', sourceInstanceId: result.sourceInstanceId };
    case 'reconfigured':
      return { kind: 'reconfigured', sourceInstanceId: result.sourceInstanceId };
    case 'reactivated':
      return { kind: 'restored', sourceInstanceId: result.sourceInstanceId };
    case 'removed':
      return { kind: 'removed', sourceInstanceId: result.sourceInstanceId };
    case 'invalidCaller':
      return { kind: 'sourceNotAdmitted' };
    case 'currentnessConflict':
      return { kind: 'raced' };
    case 'conflict':
      return { kind: 'conflict' };
    case 'atMaximum':
      return { kind: 'atMaximum' };
    default:
      // An arm published after this build. Saying nothing true is better than
      // labelling it as one of the arms we do understand.
      return { kind: 'unreadable' };
  }
}

/**
 * Advance what this page knows about a row from the arm the target returned.
 *
 * Only a success arm moves it. A `conflict`, a race, an unreadable result or a
 * transport failure leaves the previous knowledge exactly as it was: none of
 * them tells us whether a row exists, and inventing an answer is what would put
 * a Remove control on a row the target never created.
 */
export function advanceTriageSourceSettingsRowLifecycle(
  previous: TriageSourceSettingsRowLifecycleV1,
  outcome: TriageSourceSettingsConfigurationV1,
): TriageSourceSettingsRowLifecycleV1 {
  switch (outcome.kind) {
    case 'configured':
    case 'alreadyConfigured':
    case 'reconfigured':
    case 'restored':
      return { kind: 'configured', sourceInstanceId: outcome.sourceInstanceId };
    case 'removed':
      return { kind: 'retired', sourceInstanceId: outcome.sourceInstanceId };
    default:
      return previous;
  }
}

/**
 * The one sentence a row shows after the target answered.
 *
 * `conflict` is phrased for the only arm that can produce it here: a `create`
 * whose tuple already exists as a retired row this page cannot see. Saying
 * "already added" there would be a lie, and saying "failed" would send the user
 * looking at the provider.
 */
function describeTriageSourceConfiguration(
  outcome: TriageSourceSettingsConfigurationV1,
  sourceDisplayName: string,
): Readonly<{ text: string; tone: TriageSourceSettingsRowToneV1 }> | null {
  switch (outcome.kind) {
    case 'idle':
    case 'submitting':
      return null;
    case 'configured':
      return { text: `Added to ${PRODUCT_NAME}.`, tone: 'success' };
    case 'alreadyConfigured':
      return { text: `Already in ${PRODUCT_NAME}.`, tone: 'neutral' };
    case 'reconfigured':
      return { text: 'Configuration updated.', tone: 'success' };
    case 'restored':
      return { text: `Restored to ${PRODUCT_NAME}.`, tone: 'success' };
    case 'removed':
      // Removal is stated with its exact blast radius. Entries are a projection
      // of what the source can still see, so they go; a pin and a Session link
      // are the user's own state with their own lifetime, and a page that
      // implied removal discarded them would stop people from removing at all.
      return {
        text: `Removed from ${PRODUCT_NAME}. Its entries leave the list; the pins and Session links you made stay.`,
        tone: 'neutral',
      };
    case 'conflict':
      return {
        text: 'You removed this earlier. This page cannot bring it back yet.',
        tone: 'warning',
      };
    case 'atMaximum':
      return {
        text: `You have configured as many sources as ${PRODUCT_NAME} holds. Remove one you no longer use.`,
        tone: 'warning',
      };
    case 'sourceNotAdmitted':
      return {
        text: `${sourceDisplayName} is no longer an admitted ${PRODUCT_NAME} source on this account.`,
        tone: 'danger',
      };
    case 'raced':
      return { text: 'Something changed while this was saving. Try again.', tone: 'warning' };
    case 'unreadable':
      return { text: 'The response could not be read by this version.', tone: 'danger' };
    case 'outcomeUnknown':
      return {
        text: `${outcome.message} It may already have been applied; refresh before trying again.`,
        tone: 'warning',
      };
    case 'failed':
      return { text: outcome.message, tone: 'danger' };
  }
}

/**
 * The state sentence for a row whose last answer has been superseded by a
 * refresh, or that was never pressed at all.
 *
 * A configured instance this source's listing can no longer produce gets its own
 * sentence rather than the plain one, because "In PRs & Issues." beside a row the
 * source cannot read would leave the user waiting for entries that will never
 * arrive. It is stated as an unusable state with the one remedy the page can
 * still offer, and only when the listing that failed to produce it was complete.
 */
function describeLifecycle(
  lifecycle: TriageSourceSettingsRowLifecycleV1,
  presence: TriageSourceSettingsRowSubjectV1['presence'],
  sourceDisplayName: string,
): Readonly<{ text: string; tone: TriageSourceSettingsRowToneV1 }> | null {
  switch (lifecycle.kind) {
    case 'configured':
      if (presence === 'missing') {
        return {
          text: `In ${PRODUCT_NAME}, but ${sourceDisplayName} can no longer reach it. Its entries stop arriving until the account or scope comes back.`,
          tone: 'warning',
        };
      }
      if (presence === 'unlisted') {
        return {
          text: `In ${PRODUCT_NAME}. This page could not list it just now, so it may still be working.`,
          tone: 'neutral',
        };
      }
      return { text: `In ${PRODUCT_NAME}.`, tone: 'neutral' };
    case 'retired':
      return { text: `Removed from ${PRODUCT_NAME}.`, tone: 'neutral' };
    case 'unknown':
      // Not "not added": a read that could not be completed leaves a configured
      // row unknown, so silence is the only true answer.
      return null;
  }
}

function controlsFor(
  lifecycle: TriageSourceSettingsRowLifecycleV1,
  presence: TriageSourceSettingsRowSubjectV1['presence'],
  title: string,
): readonly TriageSourceSettingsRowControlV1[] {
  // Add, Update and Restore all submit a freshly discovered draft. Without one
  // there is nothing to submit, and `remove` — the only arm that names a row and
  // nothing else — is the only control that stays honest.
  const hasDraft = presence === 'discovered';
  switch (lifecycle.kind) {
    case 'unknown':
      return hasDraft
        ? [{
          id: 'add',
          label: 'Add',
          accessibilityLabel: `Add ${title} to ${PRODUCT_NAME}`,
          variant: 'primary',
        }]
        : [];
    case 'retired':
      // Restore is the only arm that may revive a retired row, and it reuses
      // that row's exact stable ref. Offering Add here would ask the target to
      // mint a second row for one intent, which it correctly refuses.
      return hasDraft
        ? [{
          id: 'restore',
          label: 'Restore',
          accessibilityLabel: `Restore ${title} to ${PRODUCT_NAME}`,
          variant: 'primary',
        }]
        : [];
    case 'configured':
      return [
        ...(hasDraft
          ? [{
            id: 'reconfigure' as const,
            label: 'Update',
            accessibilityLabel: `Update ${title} from the provider`,
            variant: 'secondary' as const,
          }]
          : []),
        {
          id: 'remove',
          label: 'Remove',
          accessibilityLabel: `Remove ${title} from ${PRODUCT_NAME}`,
          variant: 'secondary',
        },
      ];
  }
}

/**
 * Everything one row renders, from what the row is about, what this page knows
 * about its configured instance, and what the target last said about a press.
 *
 * The settled sentence wins over the lifecycle sentence because it is the newer
 * fact and the one the user just caused. The locator is dropped when it only
 * repeats the title: a row that reads `acme/api` twice tells the reader nothing
 * and reads as a rendering fault.
 */
function projectTriageSourceSettingsRow(input: Readonly<{
  subject: TriageSourceSettingsRowSubjectV1;
  lifecycle: TriageSourceSettingsRowLifecycleV1;
  /** `undefined` is spelled out: a row with no settled answer is the common case. */
  outcome?: TriageSourceSettingsConfigurationV1 | undefined;
  sourceDisplayName: string;
}>): TriageSourceSettingsRowV1 {
  const { subject, lifecycle } = input;
  const settled = input.outcome === undefined
    ? null
    : describeTriageSourceConfiguration(input.outcome, input.sourceDisplayName);
  const standing = describeLifecycle(lifecycle, subject.presence, input.sourceDisplayName);
  return {
    key: subject.key,
    title: subject.label,
    status: settled?.text ?? standing?.text ?? null,
    locator: subject.locator === subject.label ? null : subject.locator,
    tone: settled?.tone ?? standing?.tone ?? 'neutral',
    controls: controlsFor(lifecycle, subject.presence, subject.label),
    sourceInstanceId: lifecycle.kind === 'unknown' ? null : lifecycle.sourceInstanceId,
    draft: subject.presence === 'discovered' ? subject.draft : null,
    keyFollowsProviderName: subject.keyFollowsProviderName,
  };
}

function subjectFromCandidate(
  candidate: TriageSourceSettingsCandidateV1,
): TriageSourceSettingsRowSubjectV1 {
  return {
    key: candidate.key,
    label: candidate.label,
    locator: candidate.path ?? candidate.accountId,
    keyFollowsProviderName: candidate.keyFollowsProviderName,
    presence: 'discovered',
    draft: candidate.draft,
  };
}

function subjectFromConfigured(
  instance: TriageSourceSettingsConfiguredInstanceV1,
  presence: 'missing' | 'unlisted',
): TriageSourceSettingsRowSubjectV1 {
  return {
    key: instance.key,
    label: instance.label,
    locator: instance.locator,
    // Key stability is a property of a fresh discovery, not of a stored row.
    // Claiming it here would put the warning badge on a guess.
    keyFollowsProviderName: false,
    presence,
  };
}

function lifecycleFromConfigured(
  instance: TriageSourceSettingsConfiguredInstanceV1,
): TriageSourceSettingsRowLifecycleV1 {
  return instance.lifecycle === 'active'
    ? { kind: 'configured', sourceInstanceId: instance.sourceInstanceId }
    : { kind: 'retired', sourceInstanceId: instance.sourceInstanceId };
}

/**
 * Every row the page renders, from the two published reads and the presses made
 * here.
 *
 * The rows are the discovered candidates, in the order the source listed them,
 * followed by the configured instances the listing did not produce a candidate
 * for. That tail is the reason this composer exists: a configured instance whose
 * account was disconnected or whose scope was renamed disappears from discovery,
 * and a page that only rendered candidates would leave the user with a source
 * that cannot be read and cannot be removed.
 *
 * A retired instance in that tail is normally left out. It is not in the product,
 * it cannot be restored without a fresh draft, and retired rows are never deleted
 * — so listing them would grow a permanent column of rows with no control. The
 * one exception is a press made here, which stays visible so the user sees what
 * their Remove actually did.
 *
 * `learned` wins over the read for the same key, because between two reads it is
 * the newer fact, and it exists only for arms the target settled successfully. A
 * refused press writes nothing, so the read still decides — which is what turns a
 * `conflict` into a Restore on the next refresh instead of a dead end. The caller
 * discards it when it re-reads, since the read then observes the same rows after
 * those presses committed.
 */
export function projectTriageSourceSettingsRows(input: Readonly<{
  discovery: TriageSourceSettingsDiscoveryV1;
  configured: TriageSourceSettingsConfiguredV1;
  /** What the target said about each press, keyed by row key. */
  outcomes: Readonly<Record<string, TriageSourceSettingsConfigurationV1>>;
  /** What a successful press taught this page, keyed by row key. */
  learned: Readonly<Record<string, TriageSourceSettingsRowLifecycleV1>>;
  sourceDisplayName: string;
}>): readonly TriageSourceSettingsRowV1[] {
  const { configured, discovery, learned, outcomes, sourceDisplayName } = input;
  const candidates = discovery.kind === 'listed' ? discovery.candidates : [];
  const instances = configured.kind === 'read' ? configured.instances : [];
  const byKey = new Map(instances.map((instance) => [instance.key, instance]));
  const discovered = new Set(candidates.map((candidate) => candidate.key));

  function lifecycleFor(key: string): TriageSourceSettingsRowLifecycleV1 {
    const instance = byKey.get(key);
    return learned[key]
      ?? (instance === undefined
        ? UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1
        : lifecycleFromConfigured(instance));
  }

  function project(subject: TriageSourceSettingsRowSubjectV1): TriageSourceSettingsRowV1 {
    return projectTriageSourceSettingsRow({
      subject,
      lifecycle: lifecycleFor(subject.key),
      ...(outcomes[subject.key] === undefined ? {} : { outcome: outcomes[subject.key] }),
      sourceDisplayName,
    });
  }

  // Absence from an incomplete listing is not evidence that the source cannot
  // reach the instance; only a complete listing makes it evidence.
  const presence = discovery.kind === 'listed' && discovery.complete ? 'missing' : 'unlisted';
  return [
    ...candidates.map((candidate) => project(subjectFromCandidate(candidate))),
    ...instances
      .filter((instance) => (
        !discovered.has(instance.key)
        && (lifecycleFor(instance.key).kind === 'configured'
          || outcomes[instance.key] !== undefined)
      ))
      .map((instance) => project(subjectFromConfigured(instance, presence))),
  ];
}

/**
 * What the page must say when it could not learn what is already configured.
 *
 * `null` is the finished state: the read answered in full, so every row already
 * says what it is and there is nothing to add. Every other arm gets its own
 * sentence, because a page that silently fell back to Add would be telling the
 * user that a source they configured is not configured — the exact lie the
 * configured read exists to prevent.
 */
export function describeTriageSourceConfiguredRead(
  configured: TriageSourceSettingsConfiguredV1,
  sourceDisplayName: string,
): Readonly<{ title: string; description: string; tone: 'warning' | 'danger' }> | null {
  switch (configured.kind) {
    case 'loading':
      // The page is already showing that it is reading. Saying it twice would
      // turn a normal mount into a warning.
      return null;
    case 'read':
      return configured.complete
        ? null
        : {
          title: 'Not everything you configured is listed here',
          description: `${PRODUCT_NAME} holds more ${sourceDisplayName} configurations than this page can list, so one you already added may still offer Add.`,
          tone: 'warning',
        };
    case 'unreadable':
      return {
        title: 'This version cannot read what is configured',
        description: `${PRODUCT_NAME} answered outside the published contract, so this page cannot say which of these are already added.`,
        tone: 'danger',
      };
    case 'unreachable':
      return {
        title: 'What is already configured could not be read',
        description: `${configured.message} A row may offer Add for something you already added.`,
        tone: 'warning',
      };
    case 'outcomeUnknown':
      return {
        title: 'This page does not know what is already configured',
        description: 'That read did not finish. Refresh to ask again before adding anything.',
        tone: 'warning',
      };
    case 'sourceNotAdmitted':
      return {
        title: `${sourceDisplayName} is no longer an admitted ${PRODUCT_NAME} source on this account.`,
        description: `Nothing here can be added to ${PRODUCT_NAME} until it is admitted again.`,
        tone: 'danger',
      };
    case 'raced':
      return {
        title: 'This page read while something was changing',
        description: 'Refresh to see what is configured now.',
        tone: 'warning',
      };
  }
}

/**
 * This page's own words for the six failure classes, when the source supplied
 * none of its own.
 *
 * They are deliberately NOT the list shell's six. The list suffixes a predicate
 * to a connection name it has already printed; these are the fix the reader came
 * to this page to make, and each class is a materially different fix — an
 * expired account is repaired in Connected Accounts, a permission gap at the
 * provider, a rate limit on its own. One table serving both surfaces would put
 * one of the two wrong sentences on both, so they stay two tables that say the
 * same six things differently.
 *
 * Keyed by the closed class rather than switched on, so a seventh class cannot
 * compile without a sentence and a key.
 */
const TRIAGE_SOURCE_FAILURE_COPY_V1: Readonly<
  Record<TriageSourceFailureV1['class'], string>
> = Object.freeze({
  authentication: 'The connected account is no longer authorized. Reconnect it in Connected Accounts.',
  permission: 'The connected account cannot see this scope. Grant it access at the provider.',
  rateLimit: 'The provider is rate limiting this account. Try again shortly.',
  transient: 'The provider could not be reached. Try again.',
  unsupportedContract: 'The provider returned something this version cannot read.',
  unknown: 'The provider could not be read.',
});

/**
 * The catalog key for each sentence above.
 *
 * They live beside the copy so the two cannot drift, and they are this page's
 * own namespace rather than the list's: borrowing `plugins.triage.surface.*`
 * would resolve the list's predicate here and read as a fragment.
 */
const TRIAGE_SOURCE_FAILURE_TRANSLATION_KEYS_V1: Readonly<
  Record<TriageSourceFailureV1['class'], string>
> = Object.freeze({
  authentication: 'plugins.triage.sourceSettings.failure.authentication',
  permission: 'plugins.triage.sourceSettings.failure.permission',
  rateLimit: 'plugins.triage.sourceSettings.failure.rateLimit',
  transient: 'plugins.triage.sourceSettings.failure.transient',
  unsupportedContract: 'plugins.triage.sourceSettings.failure.unsupportedContract',
  unknown: 'plugins.triage.sourceSettings.failure.unknown',
});

/**
 * A resolver-free caller gets readable English rather than a raw key, which is
 * what keeps this model usable from a test and from a host too old to carry
 * this page's bundle.
 */
const ENGLISH_TEXT: PluginTranslate = (_key, fallback = '') => fallback;

/**
 * The honest sentence for one bounded source failure.
 *
 * A source that sent bounded non-secret `detail` is quoted verbatim, exactly as
 * the list shell quotes the same field: the source knows which repository,
 * project or account could not be read and this file does not, so its own words
 * are the more useful answer. They are never routed through the catalogue —
 * provider text arrives already written, and there is no key for it.
 *
 * Everything else resolves through the caller's resolver. Six hard-coded
 * English sentences rendered untranslated on every locale for all six sources,
 * and nothing failed when they did.
 */
export function describeTriageSourceFailure(
  failure: TriageSourceFailureV1,
  text: PluginTranslate = ENGLISH_TEXT,
): string {
  const sentence = text(
    TRIAGE_SOURCE_FAILURE_TRANSLATION_KEYS_V1[failure.class],
    TRIAGE_SOURCE_FAILURE_COPY_V1[failure.class],
  );
  // The source's bounded `detail` is ADDED to the class sentence, never
  // substituted for it.
  //
  // `detail` is not authored prose: real producers pass the raw error straight
  // through (`scm-azure-devops/src/triage/failures.ts:99,192-193` forwards
  // `error.message.trim()`), so it is routinely a bare `fetch failed`.
  // Substituting it here would drop the remedy — the reason this table exists at
  // all, per the rationale above — and render untranslated on all 11 locales,
  // on the one page whose whole purpose is fixing the connection.
  //
  // This deliberately differs from the list shell
  // (`plugins/triage/src/ui/shell/windowState.ts:131`), which DOES prefer
  // `detail` outright. There the class sentence is a predicate suffixed to a
  // connection name and carries no remedy, so replacing it loses nothing. One
  // union, two readers, two requirements.
  return failure.detail === undefined ? sentence : `${sentence} (${failure.detail})`;
}

/**
 * What the user is asked before one configured source is removed.
 *
 * Removal is destructive and this page cannot undo it: the target retires the
 * row, and only an explicit Restore — offered only while the source can still
 * discover that scope — brings it back. So the question is asked before the
 * arm runs, not after.
 *
 * It states the exact row rather than the source alone, because a person with
 * several projects configured from one account is choosing between rows, and
 * "Remove GitLab?" does not tell them which one they are about to lose.
 *
 * It also states the blast radius the same way the settled sentence does, and
 * for the same reason: entries are a projection of what the source can still
 * see, so they go, while a pin and a Session link are the user's own state with
 * their own lifetime (`core/CORPUS.md` §5.3). A question that left that
 * ambiguous would stop people from removing a source at all.
 */
export const TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1 = Object.freeze({
  title: 'plugins.triage.sourceSettings.removeConfirm.title',
  message: 'plugins.triage.sourceSettings.removeConfirm.message',
  unavailable: 'plugins.triage.sourceSettings.removeConfirm.unavailable',
});

export type TriageSourceRemovalConfirmationV1 = Readonly<{
  title: string;
  message: string;
}>;

/**
 * The fallback is composed here rather than passed as a template, because the
 * fallback is what a caller with no host resolver gets and a resolver-free
 * caller performs no substitution. A bundle entry still carries `{scope}`,
 * `{source}` and `{product}`, which the host resolver fills; an absent entry
 * degrades to this already-written English rather than to visible braces.
 */
export function describeTriageSourceRemovalConfirmation(
  input: Readonly<{ rowTitle: string; sourceDisplayName: string }>,
  text: PluginTranslate = ENGLISH_TEXT,
): TriageSourceRemovalConfirmationV1 {
  const { rowTitle, sourceDisplayName } = input;
  const values = { scope: rowTitle, source: sourceDisplayName, product: PRODUCT_NAME };
  return {
    title: text(
      TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1.title,
      `Remove ${rowTitle} from ${PRODUCT_NAME}?`,
      values,
    ),
    message: text(
      TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1.message,
      `${sourceDisplayName} stops contributing ${rowTitle} to ${PRODUCT_NAME}.`
        + ' Its entries leave the list; the pins and Session links you made stay.',
      values,
    ),
  };
}

/**
 * The sentence for a removal the page could not put to the user at all.
 *
 * A host that does not advertise `confirm`, a retired mount, or a withdrawn
 * question settles the request as a typed host error rather than as an answer.
 * None of those is a decline the user made, and none of them is a removal, so
 * the row says what happened instead of silently doing nothing — a Remove press
 * that produces no visible change reads as a broken button.
 */
export function describeTriageSourceRemovalUnconfirmable(
  text: PluginTranslate = ENGLISH_TEXT,
): TriageSourceSettingsConfigurationV1 {
  return {
    kind: 'failed',
    message: text(
      TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1.unavailable,
      'This removal could not be confirmed, so nothing was removed. Try again.',
    ),
    retryable: true,
  };
}
