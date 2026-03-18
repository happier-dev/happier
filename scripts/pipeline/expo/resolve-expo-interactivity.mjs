// @ts-check

/**
 * @param {string | undefined | null} value
 * @param {string} name
 * @returns {boolean | null}
 */
function parseOptionalBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${name} must be '1', '0', 'true', or 'false' (got: ${value})`);
}

/**
 * Resolves whether Expo tooling should run non-interactively.
 *
 * CI always wins, otherwise operators can explicitly opt in/out via PIPELINE_INTERACTIVE.
 * If neither env var is set, callers provide the default behavior for the command.
 *
 * @param {{
 *   ci?: string | undefined | null;
 *   pipelineInteractive?: string | undefined | null;
 *   defaultNonInteractive?: boolean;
 * }} opts
 * @returns {boolean}
 */
export function resolveExpoNonInteractive(opts) {
  const ci = parseOptionalBool(opts.ci, 'CI');
  if (ci === true) return true;

  const pipelineInteractive = parseOptionalBool(opts.pipelineInteractive, 'PIPELINE_INTERACTIVE');
  if (pipelineInteractive === true) return false;
  if (pipelineInteractive === false) return true;

  return opts.defaultNonInteractive === true;
}
