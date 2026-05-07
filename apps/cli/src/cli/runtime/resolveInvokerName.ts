import { basename } from 'node:path';

/**
 * Resolve the user-facing invoker name (`happier`, `hdev`, `hprev`, or a
 * custom shim) for the current CLI process.
 *
 * Used wherever we surface "run this command" guidance to the user — the
 * suggestion must match the binary they actually invoked, not a hardcoded
 * `happier`. When invoked as `hdev` against the dev channel, copy should
 * read `hdev daemon start`, not `happier daemon start`.
 *
 * Resolution order:
 *  1. `HAPPIER_CLI_INVOKER_NAME` env var (set by shim wrappers when known).
 *  2. `process.argv[1]` basename (the path to the CLI entry).
 *  3. `process.argv[0]` basename (the runtime — usually `node`, but on
 *     packaged single-executable builds it's the shim).
 *
 * Returns `null` when none of the candidates produce a usable name.
 * Callers typically default to `'happier'` when null, since that's the
 * canonical user-facing name.
 */
export function resolveInvokerName(): string | null {
  const envInvokerName = sanitizeInvokerName(process.env.HAPPIER_CLI_INVOKER_NAME);
  if (envInvokerName) return envInvokerName;

  for (const candidate of [process.argv[1] ?? '', process.argv[0] ?? '']) {
    const normalized = sanitizeInvokerName(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Normalize a path or env value into the canonical user-facing invoker name.
 * Strips directory parts and platform-specific suffixes (`.exe`, `.mjs`,
 * `.js`) so callers can compare against `'happier'` / `'hdev'` / `'hprev'`
 * directly.
 */
function sanitizeInvokerName(raw: string | undefined | null): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const normalized = basename(value)
    .replace(/\.exe$/i, '')
    .replace(/\.m?js$/i, '')
    .trim();
  return normalized || null;
}
