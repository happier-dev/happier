// @ts-check

/**
 * Ensure rolling release notes include an explicit "Current version" marker.
 * This helps operators quickly see what's deployed on a rolling tag like `cli-preview`.
 *
 * @param {string} notes
 * @param {string} version
 * @returns {string}
 */
export function withCurrentVersionLine(notes, version) {
  const v = String(version ?? '').trim();
  if (!v) throw new Error('version is required');
  const line = `Current version: v${v}`;

  const base = String(notes ?? '').trimEnd();
  if (!base) return line;
  if (base.includes(line)) return base;
  return `${base}\n\n${line}`;
}

