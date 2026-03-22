import path from 'node:path';

/**
 * @param {string} raw
 * @param {{ cwd: string; sourceLabel: string }} options
 * @returns {{ filename: string; tgzPath: string }}
 */
export function resolvePackedTarball(raw, options) {
  const text = String(raw ?? '').trim();
  const sourceLabel = options.sourceLabel;
  const cwd = path.resolve(options.cwd);

  if (!text) {
    throw new Error(`${sourceLabel} did not return a tarball path (cwd: ${cwd})`);
  }

  try {
    const parsed = JSON.parse(text);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const filename = typeof entry?.filename === 'string' ? entry.filename.trim() : '';
    if (!filename) {
      throw new Error(`${sourceLabel} did not return a valid filename (cwd: ${cwd})`);
    }
    return {
      filename,
      tgzPath: path.resolve(cwd, filename),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const lastLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

  if (!lastLine) {
    throw new Error(`${sourceLabel} did not return a tarball path (cwd: ${cwd})`);
  }

  const tgzPath = path.resolve(cwd, lastLine);
  return {
    filename: path.basename(tgzPath),
    tgzPath,
  };
}
