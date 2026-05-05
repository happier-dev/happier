/**
 * Unified yes/no confirm prompt.
 *
 * - Appends a `[Y/n]` or `[y/N]` hint based on the configured default.
 * - Empty input selects the default.
 * - `y`, `yes` → true; `n`, `no` → false.
 * - Any other input re-prompts up to `maxAttempts` times, then falls back to
 *   the default (so a pipe-closed stdin in non-interactive contexts can't hang).
 *
 * This is the single yes/no primitive used by the guided doctor-repair flow.
 * Other command flows are free to keep using `promptInput` when they need a
 * freeform answer.
 */

import { promptInput } from './promptInput';

export type YesNoDefault = 'yes' | 'no';

export async function promptConfirmYesNo(
  message: string,
  opts: Readonly<{ default: YesNoDefault; maxAttempts?: number }> = { default: 'yes' },
): Promise<boolean> {
  const suffix = opts.default === 'yes' ? ' [Y/n] ' : ' [y/N] ';
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const fullPrompt = `${message.trimEnd()}${suffix}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = (await promptInput(fullPrompt)).trim().toLowerCase();
    if (raw === '') {
      return opts.default === 'yes';
    }
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    // unrecognised — re-prompt
  }
  // stdin exhausted or user kept typing nonsense: fall back to the default
  return opts.default === 'yes';
}
