/**
 * The one owner of capability status words, tone, fix and blocking order (Capabilities P5 K2, §4.3), shared by
 * Happier's skills, MCP and agent pages and by plugins that manage installable things. The caller supplies the
 * words (its own translations); this module decides which status speaks, how loud, with which fix, and which
 * of several statuses wins.
 */

export type HappierCapabilityStatusKind =
  | 'ready'
  | 'off'
  | 'signin'
  | 'more_access'
  | 'key'
  | 'cantrun'
  | 'offline'
  | 'update'
  | 'modified'
  | 'pinned'
  | 'unused'
  | 'error'
  | 'masked'
  | 'signing'
  | 'connected'
  | 'expired'
  | 'revoked';

export type HappierCapabilityFixKind =
  | 'sign_in'
  | 'reconnect'
  | 'add_key'
  | 'how_to_fix'
  | 'try_again'
  | 'review_update'
  | 'compare'
  | 'turn_on'
  | 'grant_access';

export type HappierCapabilityStatus = Readonly<{
  kind: HappierCapabilityStatusKind;
  /** "on nl2": the machine the status is about, by display name. */
  machineName?: string;
  /**
   * More about the status. A quiet suffix on the pill's line ("· Oct 10", a last-known time) for most kinds; for a
   * stop or a run that cannot happen (`error`, `cantrun`) it is the reason, which the presentation hands on as
   * `reason` so it reads whole on its own line.
   */
  detail?: string;
  fix?: Readonly<{ kind: HappierCapabilityFixKind; onPress: () => void }>;
}>;

/** Catalog rows use the row's speaking policy with plain words; headers also state Off and Connected. */
export type HappierCapabilityStatusPlacement = 'row' | 'catalog' | 'header';

/** The pill's ink: amber "needs you", rose "failed", or neutral. */
export type HappierCapabilityStatusVariant = 'attention' | 'danger' | 'neutral';

export type HappierCapabilityStatusTone =
  | 'needs_you'
  | 'failed'
  | 'neutral'
  | 'quiet';

/** The caller's words for each status and fix (Happier passes its locale table; a plugin its own bundle). */
export type HappierCapabilityStatusLabels = Readonly<{
  status: (
    kind: Exclude<HappierCapabilityStatusKind, 'ready'>,
    machineName?: string,
  ) => string;
  fix: (kind: HappierCapabilityFixKind) => string;
}>;

export type HappierCapabilityStatusPresentation = Readonly<{
  /** null for 'ready' and other silent states: healthy is quiet. */
  pill: null | Readonly<{
    variant: HappierCapabilityStatusVariant;
    chrome: 'pill' | 'plain';
    label: string;
    detail?: string;
  }>;
  /** Why, in words: drawn under the pill, wrapping, never inside it. Only for statuses whose detail is a reason. */
  reason?: string;
  tone: HappierCapabilityStatusTone;
  /** Higher blocks more; the more blocking status shows when there are two. */
  blockingRank: number;
  fixLabel?: string;
}>;

type Spec = Readonly<{
  tone: HappierCapabilityStatusTone;
  rank: number;
  variant: HappierCapabilityStatusVariant;
  chrome: 'pill' | 'plain';
  /** Where the status draws nothing; `all` for `ready`. */
  silentIn?: 'all' | HappierCapabilityStatusPlacement;
  fix?: HappierCapabilityFixKind;
  /** The status's `detail` is a reason (a sentence), not a suffix: it moves under the pill. */
  detailIsReason?: true;
}>;

// Blocking order (most first): error > sign-in family > cantrun > offline > update > modified > masked > pinned > off > unused > ready.
const SPECS: Readonly<Record<HappierCapabilityStatusKind, Spec>> = {
  error: {
    tone: 'failed',
    rank: 100,
    variant: 'danger',
    chrome: 'pill',
    fix: 'try_again',
    detailIsReason: true,
  },
  signin: {
    tone: 'needs_you',
    rank: 90,
    variant: 'attention',
    chrome: 'pill',
    fix: 'sign_in',
  },
  more_access: {
    tone: 'needs_you',
    rank: 90,
    variant: 'attention',
    chrome: 'pill',
    fix: 'grant_access',
  },
  key: {
    tone: 'needs_you',
    rank: 90,
    variant: 'attention',
    chrome: 'pill',
    fix: 'add_key',
  },
  expired: {
    tone: 'needs_you',
    rank: 90,
    variant: 'attention',
    chrome: 'pill',
    fix: 'reconnect',
  },
  revoked: {
    tone: 'needs_you',
    rank: 90,
    variant: 'attention',
    chrome: 'pill',
    fix: 'reconnect',
  },
  cantrun: {
    tone: 'needs_you',
    rank: 80,
    variant: 'attention',
    chrome: 'pill',
    fix: 'how_to_fix',
    detailIsReason: true,
  },
  offline: { tone: 'neutral', rank: 70, variant: 'neutral', chrome: 'plain' },
  signing: { tone: 'neutral', rank: 65, variant: 'neutral', chrome: 'pill' },
  update: {
    tone: 'neutral',
    rank: 60,
    variant: 'neutral',
    chrome: 'pill',
    fix: 'review_update',
  },
  modified: { tone: 'neutral', rank: 50, variant: 'neutral', chrome: 'pill' },
  masked: {
    tone: 'neutral',
    rank: 40,
    variant: 'neutral',
    chrome: 'plain',
    fix: 'compare',
  },
  pinned: { tone: 'quiet', rank: 30, variant: 'neutral', chrome: 'plain' },
  // A row's where-summary already says "Off"; only a header states it.
  off: {
    tone: 'quiet',
    rank: 20,
    variant: 'neutral',
    chrome: 'plain',
    silentIn: 'row',
    fix: 'turn_on',
  },
  unused: { tone: 'quiet', rank: 10, variant: 'neutral', chrome: 'plain' },
  connected: {
    tone: 'quiet',
    rank: 5,
    variant: 'neutral',
    chrome: 'plain',
    silentIn: 'row',
  },
  ready: {
    tone: 'quiet',
    rank: 0,
    variant: 'neutral',
    chrome: 'plain',
    silentIn: 'all',
  },
};

/** Whether the status draws anything at this placement (healthy and placement-silent kinds draw nothing). */
export function doesHappierCapabilityStatusSpeak(
  status: HappierCapabilityStatus,
  placement: HappierCapabilityStatusPlacement = 'row',
): boolean {
  const silentIn = SPECS[status.kind].silentIn;
  return silentIn !== 'all' && silentIn !== (placement === 'catalog' ? 'row' : placement);
}

export function presentHappierCapabilityStatus(
  status: HappierCapabilityStatus,
  placement: HappierCapabilityStatusPlacement,
  labels: HappierCapabilityStatusLabels,
): HappierCapabilityStatusPresentation {
  const spec = SPECS[status.kind];
  const speaks =
    status.kind !== 'ready' &&
    doesHappierCapabilityStatusSpeak(status, placement);
  const fix = status.fix?.kind ?? spec.fix;
  return {
    pill:
      speaks
        ? {
            variant: spec.variant,
            chrome: placement === 'catalog' ? 'plain' : spec.chrome,
            label: labels.status(status.kind, status.machineName),
            ...(status.detail && !spec.detailIsReason
              ? { detail: status.detail }
              : {}),
          }
        : null,
    ...(speaks && status.detail && spec.detailIsReason
      ? { reason: status.detail }
      : {}),
    tone: spec.tone,
    blockingRank: spec.rank,
    ...(speaks && fix ? { fixLabel: labels.fix(fix) } : {}),
  };
}

/** The most blocking status that draws a pill at this placement (silent kinds never win); null when none does. */
export function pickMostBlockingHappierCapabilityStatus(
  statuses: readonly HappierCapabilityStatus[],
  placement: HappierCapabilityStatusPlacement = 'row',
): HappierCapabilityStatus | null {
  let best: HappierCapabilityStatus | null = null;
  let bestRank = -1;
  for (const status of statuses) {
    if (!doesHappierCapabilityStatusSpeak(status, placement)) continue;
    const rank = SPECS[status.kind].rank;
    if (rank <= bestRank) continue;
    best = status;
    bestRank = rank;
  }
  return best;
}

/**
 * The one notice a blocked capability page leads with, only for a status that blocks (needs you: amber;
 * failed: rose); quiet and neutral statuses stay in the header and rows. `null` when the status does not block.
 */
export function resolveHappierCapabilityBlockingNotice(
  status: HappierCapabilityStatus,
  labels: HappierCapabilityStatusLabels,
): null | Readonly<{
  tone: 'warning' | 'danger';
  action: null | Readonly<{
    label: string;
    onPress: () => void;
    display?: 'secondary';
  }>;
}> {
  const presentation = presentHappierCapabilityStatus(status, 'header', labels);
  if (presentation.tone !== 'needs_you' && presentation.tone !== 'failed')
    return null;
  const failed = presentation.tone === 'failed';
  const fix = status.fix;
  return {
    tone: failed ? 'danger' : 'warning',
    action:
      fix && presentation.fixLabel
        ? {
            label: presentation.fixLabel,
            onPress: fix.onPress,
            ...(failed ? { display: 'secondary' as const } : {}),
          }
        : null,
  };
}
