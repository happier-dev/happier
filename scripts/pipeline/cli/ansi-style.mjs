// @ts-check

/**
 * @typedef {{ enabled: boolean }} AnsiStyleOptions
 */

/**
 * @param {AnsiStyleOptions} opts
 */
export function createAnsiStyle(opts) {
  const enabled = opts.enabled === true;
  const RESET = '\u001b[0m';
  const BOLD = '\u001b[1m';
  const DIM = '\u001b[2m';
  const CYAN = '\u001b[36m';
  const GREEN = '\u001b[32m';
  const YELLOW = '\u001b[33m';
  const RED = '\u001b[31m';

  /**
   * @param {string} code
   * @param {string} text
   */
  function wrap(code, text) {
    return enabled ? `${code}${text}${RESET}` : text;
  }

  return {
    enabled,
    bold: (text) => wrap(BOLD, text),
    dim: (text) => wrap(DIM, text),
    cyan: (text) => wrap(CYAN, text),
    green: (text) => wrap(GREEN, text),
    yellow: (text) => wrap(YELLOW, text),
    red: (text) => wrap(RED, text),
  };
}

