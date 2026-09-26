/**
 * Options Parser Utilities
 * 
 * Utilities for parsing and formatting XML options blocks from agent responses.
 * Used for extracting and formatting <options><option>...</option></options> blocks.
 */

/**
 * Single regex owning the <option> item grammar, shared by every consumer so the
 * terminal formatter and the Gemini adapter never diverge.
 * Matches one <option>...</option> pair (case-insensitive, non-greedy inner).
 */
const OPTION_ITEM_REGEX = /<option>(.*?)<\/option>/gi;

/**
 * Regex owning the TRAILING options-block grammar. Anchored to the END of the
 * string (allowing whitespace after </options>), case-insensitive on tags, with
 * a non-greedy inner (which never spans a nested <options> opener, so the block
 * begins at the LAST opener) and tolerated whitespace around that inner. This
 * is the sole matcher for a turn-final options block; literal or fenced
 * <options> markup appearing earlier in the text is intentionally NOT matched.
 */
const TRAILING_OPTIONS_BLOCK_REGEX = /<options>\s*((?:(?!<options>)[\s\S])*?)\s*<\/options>\s*$/i;

/**
 * Parse the non-empty <option> texts out of an options-block inner string.
 * 
 * @param inner - The inner content between <options> and </options>
 * @returns Array of trimmed, non-empty option strings (empty tags dropped)
 */
function parseOptionItems(inner: string): string[] {
  const options: string[] = [];
  let optionMatch: RegExpExecArray | null;
  OPTION_ITEM_REGEX.lastIndex = 0;
  while ((optionMatch = OPTION_ITEM_REGEX.exec(inner)) !== null) {
    const optionText = optionMatch[1].trim();
    if (optionText) {
      options.push(optionText);
    }
  }
  return options;
}

/**
 * Detect a still-streaming (unclosed) trailing options block: the LAST
 * <options> opener in `text` has no matching </options> after it.
 * 
 * @param text - The text to inspect
 * @returns true when the final <options> opener is not yet closed
 */
function hasUnclosedTrailingOptions(text: string): boolean {
  const openRegex = /<options>/gi;
  let lastOpenEnd = -1;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openRegex.exec(text)) !== null) {
    lastOpenEnd = openMatch.index + openMatch[0].length;
  }
  if (lastOpenEnd === -1) {
    return false;
  }
  return !/<\/options>/i.test(text.slice(lastOpenEnd));
}

/**
 * Canonical trailing-options segmenter — the sole owner of the options-block
 * grammar, reused by the terminal formatter AND the Gemini adapter.
 *
 * Splits `text` into the prose BEFORE a turn-final <options> block and the
 * parsed option list, WITHOUT mutating any surrounding whitespace. Only a
 * <options>...</options> block anchored to the END of `text` (optionally
 * followed by trailing whitespace) is recognised; literal or fenced <options>
 * markup appearing mid-text stays part of `before`, untouched.
 *
 * @param text - The full assistant/turn text to segment
 * @returns before (verbatim prose preceding the block, or the full text when no
 *   trailing block matched), options (non-empty trimmed option strings), and
 *   hasIncompleteTrailingOptions (true only for a trailing opener with no closer)
 */
export function segmentTrailingOptions(text: string): {
  before: string;
  options: string[];
  hasIncompleteTrailingOptions: boolean;
} {
  const match = text.match(TRAILING_OPTIONS_BLOCK_REGEX);
  if (!match) {
    return {
      before: text,
      options: [],
      hasIncompleteTrailingOptions: hasUnclosedTrailingOptions(text),
    };
  }
  const before = text.slice(0, match.index);
  const options = parseOptionItems(match[1]);
  return { before, options, hasIncompleteTrailingOptions: false };
}

/**
 * Format options array as XML string
 * 
 * @param options - Array of option strings
 * @returns XML formatted string with <options> block
 */
export function formatOptionsXml(options: string[]): string {
  if (options.length === 0) {
    return '';
  }
  return '\n<options>\n' + options.map(opt => `    <option>${opt}</option>`).join('\n') + '\n</options>';
}

/**
 * Format assistant text for terminal display.
 * Replaces ONLY a turn-final <options>...</options> block with a readable
 * numbered list so terminal surfaces (which have no tappable option buttons) do
 * not show raw XML. Everything before the block — including all whitespace — is
 * preserved verbatim; the only span that changes is the trailing options block.
 * Literal or fenced <options> markup earlier in the text is left untouched, and
 * a still-streaming (unclosed) trailing block passes through unchanged.
 *
 * @param text - The assistant text potentially ending in an options XML block
 * @returns The text with a trailing options block rendered as a numbered list
 */
export function formatTextWithOptionsForTerminal(text: string): string {
  const { before, options, hasIncompleteTrailingOptions } = segmentTrailingOptions(text);
  if (hasIncompleteTrailingOptions) {
    // Don't rewrite a block that is still streaming in.
    return text;
  }
  if (options.length === 0) {
    // No trailing block (before === text) or a trailing block with no non-empty
    // options (before drops the empty block); either way return before verbatim.
    return before;
  }
  const numberedList = options
    .map((option, index) => `  ${index + 1}. ${option}`)
    .join('\n');
  return `${before}Options:\n${numberedList}`;
}
