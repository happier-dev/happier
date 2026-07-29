export type ClaudeResumeSummaryCompactResidueEpisode = Readonly<{
  arm: () => void;
  ownsComposerDraft: (draft: string) => boolean;
  cancel: () => void;
}>;

/**
 * Runtime-local provenance for Claude's native `resume_from_summary` side effect. Claude submits
 * `/compact` itself, but can leave that exact command in the composer after the compact turn ends.
 * The episode is intentionally neither persisted nor timed: the first idle empty/different
 * composer cancels it, while the canonical draft guard may recapture the same exact residue.
 */
export function createClaudeResumeSummaryCompactResidueEpisode(): ClaudeResumeSummaryCompactResidueEpisode {
  let armed = false;

  return Object.freeze({
    arm() {
      armed = true;
    },
    ownsComposerDraft(draft) {
      if (!armed) return false;
      if (draft.length === 0) {
        armed = false;
        return false;
      }
      if (/^\/compact[ \t\r\n]*$/u.test(draft)) return true;
      armed = false;
      return false;
    },
    cancel() {
      armed = false;
    },
  });
}
