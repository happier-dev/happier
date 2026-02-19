// @ts-check

/**
 * Minimal dotenv parser:
 * - supports KEY=VALUE
 * - supports quoted values "..." or '...'
 * - supports multiline quoted values spanning newlines
 * - ignores blank lines and comments starting with #
 * - does not expand variables
 *
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseDotenv(raw) {
  /** @type {Record<string, string>} */
  const out = {};

  const input = String(raw ?? '');
  let i = 0;

  const isLineBreak = (ch) => ch === '\n' || ch === '\r';
  const skipToLineEnd = () => {
    while (i < input.length && !isLineBreak(input[i])) i += 1;
  };
  const consumeLineBreak = () => {
    if (input[i] === '\r') i += 1;
    if (input[i] === '\n') i += 1;
  };
  const skipLeadingWhitespace = () => {
    while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i += 1;
  };

  // Optional UTF-8 BOM (common when env files are edited in some tools).
  if (input.charCodeAt(0) === 0xfeff) i += 1;

  while (i < input.length) {
    skipLeadingWhitespace();

    if (i >= input.length) break;

    if (isLineBreak(input[i])) {
      consumeLineBreak();
      continue;
    }

    if (input[i] === '#') {
      skipToLineEnd();
      consumeLineBreak();
      continue;
    }

    const keyStart = i;
    while (i < input.length && input[i] !== '=' && !isLineBreak(input[i])) i += 1;
    if (i >= input.length || input[i] !== '=') {
      skipToLineEnd();
      consumeLineBreak();
      continue;
    }

    const key = input.slice(keyStart, i).trim();
    i += 1; // '='
    if (!key) {
      skipToLineEnd();
      consumeLineBreak();
      continue;
    }

    skipLeadingWhitespace();

    if (i >= input.length) {
      out[key] = '';
      break;
    }

    const first = input[i];
    if (first === '"' || first === "'") {
      const quote = first;
      i += 1;
      /** @type {string[]} */
      const buf = [];

      while (i < input.length) {
        const ch = input[i];
        if (ch === quote) {
          i += 1;
          break;
        }

        if (quote === '"' && ch === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === 'n') {
            buf.push('\n');
            i += 2;
            continue;
          }
          if (next === 'r') {
            buf.push('\r');
            i += 2;
            continue;
          }
          if (next === 't') {
            buf.push('\t');
            i += 2;
            continue;
          }
          if (next === '"' || next === '\\') {
            buf.push(next);
            i += 2;
            continue;
          }
        }

        buf.push(ch);
        i += 1;
      }

      // Ignore any trailing content on the same physical line.
      skipToLineEnd();
      consumeLineBreak();

      out[key] = buf.join('');
      continue;
    }

    const valueStart = i;
    skipToLineEnd();
    const value = input.slice(valueStart, i).trim();
    consumeLineBreak();
    out[key] = value;
  }

  return out;
}
