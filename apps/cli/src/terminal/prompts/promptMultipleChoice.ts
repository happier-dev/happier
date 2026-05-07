import { promptInput } from './promptInput';

/**
 * Multi-choice prompt that accepts single-letter inputs. Shown as a list of
 * options the user picks with a short letter (or full word). Empty input picks
 * the default. Unrecognised input re-prompts.
 *
 * Keeps inputs short — `Y/n/r/p` — rather than requiring users to type whole
 * words. Case-insensitive.
 */
export type MultipleChoiceOption<TId extends string> = Readonly<{
  /** The id returned when this option is chosen. */
  id: TId;
  /**
   * The single-letter key (or multi-char word) the user types. Multiple
   * accepted aliases allowed — e.g. `['y', 'yes']`. Case-insensitive.
   */
  keys: readonly string[];
  /** Short label used in the `[Y/n/r/p]` suffix. Usually a single uppercase letter when default, lowercase otherwise. */
  short: string;
}>;

export async function promptMultipleChoice<TId extends string>(
  message: string,
  options: readonly MultipleChoiceOption<TId>[],
  config: Readonly<{ defaultId: TId; maxAttempts?: number }>,
): Promise<TId> {
  if (options.length === 0) {
    throw new Error('promptMultipleChoice requires at least one option');
  }
  const maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  const suffix = `[${options.map((o) => (o.id === config.defaultId ? o.short.toUpperCase() : o.short.toLowerCase())).join('/')}] `;
  const fullPrompt = `${message.trimEnd()} ${suffix}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = (await promptInput(fullPrompt)).trim().toLowerCase();
    if (raw === '') return config.defaultId;
    const match = options.find((o) => o.keys.some((k) => k.toLowerCase() === raw));
    if (match) return match.id;
    // unrecognised — re-prompt
  }
  return config.defaultId;
}
