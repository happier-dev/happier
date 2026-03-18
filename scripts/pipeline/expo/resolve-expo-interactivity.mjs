// @ts-check

/**
 * @param {string | undefined | null} value
 * @returns {'auto' | 'true' | 'false'}
 */
export function normalizeInteractiveOverride(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'auto' || raw === 'true' || raw === 'false') return raw;
  throw new Error(`--interactive must be 'auto', 'true', or 'false' (got: ${value})`);
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   stdinIsTty?: boolean;
 *   stdoutIsTty?: boolean;
 *   interactiveOverride?: string;
 *   defaultMode?: 'tty' | 'non-interactive';
 * }} [opts]
 */
export function resolveExpoInteractivity(opts = {}) {
  const env = opts.env ?? process.env;
  const isCi = String(env.CI ?? '').trim().toLowerCase() === 'true' || String(env.GITHUB_ACTIONS ?? '').trim() === 'true';
  const hasInteractiveTty = Boolean(opts.stdinIsTty ?? process.stdin.isTTY) && Boolean(opts.stdoutIsTty ?? process.stdout.isTTY);
  const defaultMode = opts.defaultMode === 'non-interactive' ? 'non-interactive' : 'tty';
  const interactiveOverride = normalizeInteractiveOverride(opts.interactiveOverride);
  const rawOverride = String(env.PIPELINE_INTERACTIVE ?? '').trim().toLowerCase();
  const forceInteractive = rawOverride === '1' || rawOverride === 'true';
  const forceNonInteractive = rawOverride === '0' || rawOverride === 'false';

  if (isCi) {
    return {
      isCi,
      hasInteractiveTty,
      nonInteractive: true,
      source: 'ci',
    };
  }

  if (interactiveOverride === 'true') {
    return {
      isCi,
      hasInteractiveTty,
      nonInteractive: false,
      source: 'arg-force-interactive',
    };
  }

  if (interactiveOverride === 'false') {
    return {
      isCi,
      hasInteractiveTty,
      nonInteractive: true,
      source: 'arg-force-non-interactive',
    };
  }

  if (forceInteractive) {
    return {
      isCi,
      hasInteractiveTty,
      nonInteractive: false,
      source: 'env-force-interactive',
    };
  }

  if (forceNonInteractive) {
    return {
      isCi,
      hasInteractiveTty,
      nonInteractive: true,
      source: 'env-force-non-interactive',
    };
  }

  return {
    isCi,
    hasInteractiveTty,
    nonInteractive: defaultMode === 'non-interactive' ? true : !hasInteractiveTty,
    source: defaultMode === 'non-interactive' ? 'default-non-interactive' : hasInteractiveTty ? 'tty-auto' : 'non-tty-auto',
  };
}
