import chalk from 'chalk';

/**
 * Shared CLI text style palette for doctor-repair rendering.
 *
 * Severity drives every color choice. There are only FOUR severity colors:
 *
 *   error   — red    — something broke or failed; user must act
 *   action  — yellow — fixable, decision needed from the user
 *   success — green  — confirmation after an action completed
 *   info    — gray   — context / advisory / de-emphasized
 *
 * Anything else stays in default terminal color. Bold is reserved for
 * structural roles — section headers and finding titles — NOT for emphasis
 * inside body prose. Inline commands/paths/URLs use `code()` (cyan, never
 * bold). See apps/cli/CLAUDE.md for the full rationale.
 */

// ─── Severity primitives ─────────────────────────────────────────────────────

export const severity = {
  error: (text: string): string => chalk.red.bold(text),
  action: (text: string): string => chalk.yellow.bold(text),
  success: (text: string): string => chalk.green(text),
  info: (text: string): string => chalk.gray(text),
};

export const glyph = {
  error: (): string => chalk.red.bold('✗'),
  action: (): string => chalk.yellow.bold('●'),
  success: (): string => chalk.green('✓'),
  // `○` (hollow circle) gives the info/idle row the same visual weight as
  // `●` without implying a problem. The earlier `·` (middle dot) was too
  // small to distinguish from table separators at normal terminal sizes.
  info: (): string => chalk.gray('○'),
  arrow: (): string => chalk.cyan('→'),
};

// ─── Structural helpers ──────────────────────────────────────────────────────

export function sectionHeader(text: string): string {
  return chalk.bold(text);
}

/** Inline commands, paths, URLs. Cyan, never bold. */
export function code(text: string): string {
  return chalk.cyan(text);
}

// ─── Legacy aliases (kept so existing call sites compile unchanged). ──────────
// Prefer the severity/glyph/sectionHeader/code helpers above in new code.

export function muted(text: string): string {
  return severity.info(text);
}

export function bold(text: string): string {
  return chalk.bold(text);
}

export function warning(text: string): string {
  return severity.action(text);
}

export function success(text: string): string {
  return severity.success(text);
}

/** Status glyph on entry cards: green when running/healthy, yellow when drifted, gray when stopped. */
export function statusGlyph(kind: 'running' | 'drifted' | 'stopped'): string {
  if (kind === 'running') return chalk.green('●');
  if (kind === 'drifted') return chalk.yellow('●');
  return chalk.gray('●');
}

/** Indent-arrow used for the secondary muted sub-line under a card. */
export function subLineArrow(): string {
  return chalk.gray('↳');
}

// ─── Value formatters (unchanged) ────────────────────────────────────────────

/**
 * Compact a semver build suffix so wide preview/dev builds
 * like `0.2.1-preview.1775503793.4227` render as `0.2.1-preview.4227`.
 */
export function compactVersion(version: string): string {
  const trimmed = String(version ?? '').trim();
  if (!trimmed) return trimmed;
  return trimmed.replace(/\.(\d{10,})(?=\.|$|-)/g, '');
}

/**
 * Clean a relay-runtime "version" string for display.
 *
 * Some installs record the full release-asset filename
 * (`happier-server-v0.2.4-darwin-arm64`) instead of a bare semver. This
 * helper strips that boilerplate. For legit prerelease tags like
 * `0.2.1-preview.4227` it keeps the full string — the suffix is meaningful
 * there, unlike platform/arch tokens which are noise.
 */
export function cleanRelayRuntimeVersion(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim();
  if (!v) return 'unknown';
  if (/^happier-server[-v]/i.test(v)) {
    const m = v.match(/v?(\d+\.\d+\.\d+)/);
    if (m) return m[1];
  }
  const match = v.match(/v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
  return compactVersion(match ? match[1] : v);
}

/**
 * Make an auto-generated serverId friendlier to read.
 *   127.0.0.1-53488 → local relay (port 53488)
 *   localhost-41872 → local relay (port 41872)
 */
export function friendlyServerId(serverId: string): string {
  const s = String(serverId ?? '').trim();
  const loopbackMatch = s.match(/^(?:127\.0\.0\.1|localhost)-(\d+)$/);
  if (loopbackMatch) {
    return `local relay (port ${loopbackMatch[1]})`;
  }
  return s;
}

/** Shorten an absolute path under the user's home dir to `~/...` for display. */
export function compactHomePath(absolutePath: string | null | undefined): string {
  const p = String(absolutePath ?? '').trim();
  if (!p) return p;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home + '/')) return `~${p.slice(home.length)}`;
  if (home && p === home) return '~';
  return p;
}
