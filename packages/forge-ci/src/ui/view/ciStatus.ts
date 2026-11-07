import type { CheckStatusKind, TextTone } from '@happier-dev/plugin-ui';
import type { ForgeCiStateV1 } from '@happier-dev/triage-protocol/ci/v1';

export type ForgeCiStatusPresentationV1 = Readonly<{
  kind: CheckStatusKind;
  /** The state word, sentence case ("Failed", "Timed out", "Waiting for you"). */
  word: string;
  wordKey: string;
  tone: TextTone;
}>;

const word = (
  kind: CheckStatusKind,
  key: string,
  text: string,
  tone: TextTone = 'secondary',
): ForgeCiStatusPresentationV1 =>
  Object.freeze({ kind, word: text, wordKey: `forgeCi.status.${key}`, tone });

const PRESENTATION = Object.freeze({
  success: word('passed', 'succeeded', 'Succeeded'),
  failure: word('failed', 'failed', 'Failed', 'danger'),
  timed_out: word('failed', 'timedOut', 'Timed out', 'danger'),
  startup_failure: word('failed', 'startupFailed', 'Couldn’t start', 'danger'),
  cancelled: word('cancelled', 'cancelled', 'Cancelled', 'muted'),
  skipped: word('skipped', 'skipped', 'Skipped', 'muted'),
  neutral: word('neutral', 'neutral', 'Neutral', 'muted'),
  stale: word('neutral', 'stale', 'Stale', 'muted'),
  action_required: word(
    'waiting',
    'actionRequired',
    'Needs action',
    'attention',
  ),
  unknown: word('unknown', 'unknown', 'Unknown', 'muted'),
  queued: word('queued', 'queued', 'Queued'),
  running: word('running', 'running', 'Running'),
  waiting: word('waiting', 'waiting', 'Waiting for you', 'attention'),
});

/**
 * One CI state as the shared status mark and word. Forge state facts decide; the native label never chooses a
 * colour, and an unknown outcome is never drawn as a pass.
 */
export function presentForgeCiStatusV1(
  state: ForgeCiStateV1,
): ForgeCiStatusPresentationV1 {
  if (state.phase === 'unknown') return PRESENTATION.unknown;
  if (state.phase !== 'completed') return PRESENTATION[state.phase];
  return PRESENTATION[state.outcome];
}

/** Failed, then waiting on a person, then running and queued, then the rest: what a reader needs first. */
export function forgeCiStatusRankV1(state: ForgeCiStateV1): number {
  const kind = presentForgeCiStatusV1(state).kind;
  return kind === 'failed'
    ? 0
    : kind === 'waiting'
      ? 1
      : kind === 'running'
        ? 2
        : kind === 'queued'
          ? 3
          : 4;
}
