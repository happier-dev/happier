/**
 * The source-neutral model behind a source's own Triage Settings page.
 *
 * It reads two published contracts and nothing else: the source's own
 * `listInstances` result, and the target-owned source-administration result. It
 * holds no provider knowledge, no account catalogue, no configured-instance
 * store, and no source id — a second source using the same shapes reaches the
 * same conclusions from the same bytes.
 *
 * Both results are parsed through their published schemas rather than read off
 * an `unknown`, because a settings page is the one surface where a misread
 * means the user configures something other than what they chose. A result that
 * does not admit is reported as unreadable, never rendered around.
 *
 * It also owns what a row may claim about itself. A row's lifecycle advances
 * only on a success arm the target actually returned: a page that inferred
 * "configured" from a failed or unknown outcome would offer Remove for a row
 * that was never created.
 */

import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import {
  TriageListInstancesResultV1Schema,
  TriageSourceAdministrationActionResultV1Schema,
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
 * What this page knows about one candidate's durable configured row.
 *
 * `unknown` is the honest starting state and the state every remount begins in:
 * the target publishes no caller-scoped read of the caller's own configured
 * instances, so this page learns a `sourceInstanceId` only from an
 * administration arm it invoked itself. It never means "not configured" — which
 * is exactly why an `unknown` row offers Add and says nothing else about its
 * state.
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

/** Everything a candidate row renders, derived once so six pages cannot disagree. */
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
 */
function candidateKey(draft: TriageSourceInstanceDraftV1): string {
  return [
    draft.binding.purpose,
    draft.binding.account.service.pluginId,
    draft.binding.account.service.localId,
    draft.binding.account.accountId,
    draft.localInstanceKey,
  ].join(KEY_SEPARATOR);
}

function projectCandidate(draft: TriageSourceInstanceDraftV1): TriageSourceSettingsCandidateV1 {
  return {
    key: candidateKey(draft),
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
export function describeTriageSourceConfiguration(
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

/** The state sentence for a row whose last answer has been superseded by a refresh. */
function describeLifecycle(lifecycle: TriageSourceSettingsRowLifecycleV1): string | null {
  switch (lifecycle.kind) {
    case 'configured':
      return `In ${PRODUCT_NAME}.`;
    case 'retired':
      return `Removed from ${PRODUCT_NAME}.`;
    case 'unknown':
      // Not "not added": this page cannot see a configured row it did not
      // create, so silence is the only true answer.
      return null;
  }
}

function controlsFor(
  lifecycle: TriageSourceSettingsRowLifecycleV1,
  title: string,
): readonly TriageSourceSettingsRowControlV1[] {
  switch (lifecycle.kind) {
    case 'unknown':
      return [{
        id: 'add',
        label: 'Add',
        accessibilityLabel: `Add ${title} to ${PRODUCT_NAME}`,
        variant: 'primary',
      }];
    case 'retired':
      // Restore is the only arm that may revive a retired row, and it reuses
      // that row's exact stable ref. Offering Add here would ask the target to
      // mint a second row for one intent, which it correctly refuses.
      return [{
        id: 'restore',
        label: 'Restore',
        accessibilityLabel: `Restore ${title} to ${PRODUCT_NAME}`,
        variant: 'primary',
      }];
    case 'configured':
      return [
        {
          id: 'reconfigure',
          label: 'Update',
          accessibilityLabel: `Update ${title} from the provider`,
          variant: 'secondary',
        },
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
 * Everything one candidate row renders, from the candidate the source produced,
 * what the target last told this page, and what this page knows about the row.
 *
 * The settled sentence wins over the lifecycle sentence because it is the newer
 * fact and the one the user just caused. The locator is dropped when it only
 * repeats the title: a row that reads `acme/api` twice tells the reader nothing
 * and reads as a rendering fault.
 */
export function projectTriageSourceSettingsRow(input: Readonly<{
  candidate: TriageSourceSettingsCandidateV1;
  lifecycle: TriageSourceSettingsRowLifecycleV1;
  /** `undefined` is spelled out: a row with no settled answer is the common case. */
  outcome?: TriageSourceSettingsConfigurationV1 | undefined;
  sourceDisplayName: string;
}>): TriageSourceSettingsRowV1 {
  const { candidate, lifecycle } = input;
  const settled = input.outcome === undefined
    ? null
    : describeTriageSourceConfiguration(input.outcome, input.sourceDisplayName);
  const locator = candidate.path ?? candidate.accountId;
  return {
    key: candidate.key,
    title: candidate.label,
    status: settled?.text ?? describeLifecycle(lifecycle),
    locator: locator === candidate.label ? null : locator,
    tone: settled?.tone ?? 'neutral',
    controls: controlsFor(lifecycle, candidate.label),
    sourceInstanceId: lifecycle.kind === 'unknown' ? null : lifecycle.sourceInstanceId,
    keyFollowsProviderName: candidate.keyFollowsProviderName,
  };
}

/**
 * The honest sentence for one bounded source failure.
 *
 * Each class is a materially different answer for the person configuring a
 * source — an expired account is fixed in Connected Accounts, a permission gap
 * is fixed at the provider, a rate limit resolves on its own — so they do not
 * share one "could not load" line.
 */
export function describeTriageSourceFailure(failure: TriageSourceFailureV1): string {
  switch (failure.class) {
    case 'authentication':
      return 'The connected account is no longer authorized. Reconnect it in Connected Accounts.';
    case 'permission':
      return 'The connected account cannot see this scope. Grant it access at the provider.';
    case 'rateLimit':
      return 'The provider is rate limiting this account. Try again shortly.';
    case 'transient':
      return 'The provider could not be reached. Try again.';
    case 'unsupportedContract':
      return 'The provider returned something this version cannot read.';
    default:
      return 'The provider could not be read.';
  }
}
