import type { HappierReleaseGlyph, HappierReleaseOutcome, HappierStagedMoveHint } from './ReleasePreview.js';

/**
 * The ONE outcome presenter for entity drag and drop (DnD lab E1 / KS / ST): what the carried card,
 * the docked keyboard preview, the chooser announcement and the source row's lasting line say about
 * the drag owner's current verdict. Core lists, panes, Boards, plugin targets and hosted HTML all
 * describe a verdict through here, so one outcome is never worded two ways.
 *
 * It decides words and tone only. Admission, the effect and its result stay with the host's drag owner
 * and the domain Action; the vocabulary supplies localized copy, while targets declare the mark in
 * their preview. Shapes are structural so the protocol's and the SDK's projections both fit.
 */

type DropPreview = Readonly<{ verb: string; target: string; consequence?: string | undefined; glyph?: HappierReleaseGlyph | undefined }>;
type DropReason = Readonly<{ code: string; message: string }>;

export type HappierDropEffect = Readonly<{ actionId: string; input: unknown; preview: DropPreview }>;

export type HappierDropAdmission =
  | Readonly<{ status: 'allowed'; effect: HappierDropEffect }>
  | Readonly<{ status: 'refused'; reason: DropReason; preview?: DropPreview | undefined }>;

export type HappierDropSettlement =
  | Readonly<{ status: 'applied' }>
  | Readonly<{ status: 'refused' | 'unknown'; reason: DropReason }>;

export type HappierDropVerdict = Readonly<{
  phase: 'idle' | 'carrying' | 'pending' | 'settled';
  admission: HappierDropAdmission | null;
  outcome?: HappierDropSettlement | null;
}>;

export type HappierDropOutcomeVocabulary = Readonly<{
  /** Released and waiting for the owner ("Putting under …"); defaults to the effect's verb. */
  pendingTitle?: (effect: HappierDropEffect) => string;
  /** "Waiting for the Home to confirm". */
  pendingDetail: string;
  /** A refusal that names no verb of its own ("Can't move it here"). */
  refusedTitle: string;
  /** A dispatched effect the owner later refused ("Couldn't put Review under Fix"). */
  lateRefusalTitle: (effect: HappierDropEffect, itemTitle: string | null) => string;
  /** A dispatched effect whose result is unknown ("Not sure Put under Fix went through"). */
  unknownTitle: (effect: HappierDropEffect, itemTitle: string | null) => string;
  /** What to do about an unknown result ("Check the list in a moment before trying again"). */
  unknownDetail: string;
  /** Reason codes meaning releasing here changes nothing ("Already here"): quiet, never a refusal. */
  unchangedCodes?: ReadonlySet<string>;
  /** Reason codes meaning nothing under the pointer answers: the card shows only what it carries. */
  silentCodes?: ReadonlySet<string>;
}>;

/**
 * The strip's second line: the consequence, or, when an effect declares none and its verb does not
 * name its target ("Add"), the target itself, so the card never says a bare verb.
 */
function effectDetail(preview: DropPreview): string | undefined {
  if (preview.consequence) return preview.consequence;
  const target = preview.target.trim();
  return target.length > 0 && !preview.verb.toLocaleLowerCase().includes(target.toLocaleLowerCase()) ? target : undefined;
}

function glyphOf(effect: HappierDropEffect): HappierReleaseGlyph {
  return effect.preview.glyph ?? 'add';
}

/**
 * A dispatched effect the owner refused or could not confirm: the lasting line under the source and
 * the returning card say the same. `null` for anything else (no dispatch, applied, or "already here").
 */
export function describeHappierSettledDrop(
  verdict: HappierDropVerdict,
  vocabulary: HappierDropOutcomeVocabulary,
  itemTitle: string | null = null,
): Readonly<{ kind: 'refused' | 'unknown'; glyph: HappierReleaseGlyph; title: string; detail: string }> | null {
  const { admission, outcome } = verdict;
  if (verdict.phase !== 'settled' || admission?.status !== 'allowed' || !outcome || outcome.status === 'applied') return null;
  if (vocabulary.unchangedCodes?.has(outcome.reason.code)) return null;
  const glyph = glyphOf(admission.effect);
  return outcome.status === 'refused'
    ? { kind: 'refused', glyph, title: vocabulary.lateRefusalTitle(admission.effect, itemTitle), detail: outcome.reason.message }
    : { kind: 'unknown', glyph, title: vocabulary.unknownTitle(admission.effect, itemTitle), detail: vocabulary.unknownDetail };
}

/**
 * The release preview for the owner's verdict. A refused place draws the refusal mark with the
 * owner's reason; "already here" is quiet; a released effect stays visibly uncommitted until its owner
 * answers; a late refusal or an unknown result keeps the words the source line will keep.
 */
export function describeHappierDropOutcome(
  verdict: HappierDropVerdict,
  vocabulary: HappierDropOutcomeVocabulary,
  itemTitle: string | null = null,
): HappierReleaseOutcome | null {
  // A late refusal reads as a refusal (the card returns with it); an unknown result is quiet:
  // nothing is known to be wrong, and nothing is described as rolled back.
  const settled = describeHappierSettledDrop(verdict, vocabulary, itemTitle);
  if (settled) {
    return settled.kind === 'refused'
      ? { tone: 'refused', title: settled.title, detail: settled.detail }
      : { tone: 'quiet', glyph: settled.glyph, title: settled.title, detail: settled.detail };
  }
  const admission = verdict.admission;
  // Settled: only a refusal at release keeps the card's words; an answered dispatch has said its piece.
  if (!admission || verdict.phase === 'idle' || (verdict.phase === 'settled' && admission.status === 'allowed')) return null;
  if (admission.status === 'refused') {
    const code = admission.reason.code;
    if (vocabulary.silentCodes?.has(code)) return null;
    const title = admission.preview?.verb ?? vocabulary.refusedTitle;
    return vocabulary.unchangedCodes?.has(code)
      ? { tone: 'quiet', glyph: 'here', title, detail: admission.reason.message }
      : { tone: 'refused', title, detail: admission.reason.message };
  }
  const { effect } = admission;
  if (verdict.phase === 'pending') {
    return {
      tone: 'pending',
      glyph: glyphOf(effect),
      title: vocabulary.pendingTitle?.(effect) ?? effect.preview.verb,
      detail: vocabulary.pendingDetail,
    };
  }
  const detail = effectDetail(effect.preview);
  return {
    tone: 'allowed',
    glyph: glyphOf(effect),
    title: effect.preview.verb,
    ...(detail ? { detail } : {}),
  };
}

/** One spoken line for a release preview, for the polite status that mirrors it. */
export function describeHappierDropAnnouncement(outcome: HappierReleaseOutcome | null): string {
  return outcome ? [outcome.title, outcome.detail].filter(Boolean).join('. ') : '';
}

/**
 * The staged keyboard move's key hints (lab KS), drawn the same way under every list: ↑ ↓ choose,
 * → / ← go in and out where the list nests (mirrored for right-to-left), ↵ drops, the localized
 * escape key cancels. Labels come from the host, already localized.
 */
export function resolveHappierStagedMoveHints(input: Readonly<{
  labels: Readonly<{ choose: string; drop: string; cancel: string; escapeKey: string; in?: string; out?: string }>;
  rtl?: boolean;
}>): readonly HappierStagedMoveHint[] {
  const { labels } = input;
  const inKey = input.rtl === true ? '←' : '→';
  const outKey = input.rtl === true ? '→' : '←';
  return [
    { keys: ['↑', '↓'], label: labels.choose },
    ...(labels.in ? [{ keys: [inKey], label: labels.in }] : []),
    ...(labels.out ? [{ keys: [outKey], label: labels.out }] : []),
    { keys: ['↵'], label: labels.drop },
    { keys: [labels.escapeKey], label: labels.cancel },
  ];
}
