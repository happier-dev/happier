import { isPlainComposerCaptureAmbiguous, type ClaudeScreenState } from './screenState.js';

export function isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(
  rawText: string,
  screen: ClaudeScreenState,
): boolean {
  return isPlainComposerCaptureAmbiguous({ rawText, screen });
}
