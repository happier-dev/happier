import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Returns an absolute path to this package's `bin/hapsta.mjs` if present.
 * This is the most reliable way to re-run Hapsta commands from an LLM prompt
 * when `npx` is unreliable (e.g. npm cache permission issues).
 */
export function resolveLocalHapstaBinPath() {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // scripts/utils/llm
    const root = resolve(here, '../../..'); // package root (contains bin/ and scripts/)
    const p = join(root, 'bin', 'hapsta.mjs');
    return existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

export function buildHapstaRunnerShellSnippet({ preferLocalBin = true } = {}) {
  const localBin = preferLocalBin ? resolveLocalHapstaBinPath() : '';
  const localClause = localBin
    ? [
        `HAPSTA_LOCAL_BIN=${JSON.stringify(localBin)}`,
        '  if [ -f "$HAPSTA_LOCAL_BIN" ]; then',
        '    node "$HAPSTA_LOCAL_BIN" "$@"',
        '    return $?',
        '  fi',
      ].join('\n')
    : '';

  return [
    'Hapsta (Happier Stack) command runner:',
    '- In the commands below, run `hapsta ...`.',
    '- This avoids `npx` flakiness by preferring a local `bin/hapsta.mjs` when available.',
    '',
    '```bash',
    'hapsta() {',
    '  # Prefer an installed `hapsta` if present.',
    '  if command -v hapsta >/dev/null 2>&1; then',
    '    command hapsta "$@"',
    '    return $?',
    '  fi',
    localClause,
    '  # Fallback: npx. Work around broken ~/.npm perms by using a fresh writable cache dir.',
    '  if command -v npx >/dev/null 2>&1; then',
    '    local cache_dir',
    '    cache_dir="${HAPPIER_STACK_NPX_CACHE_DIR:-$(mktemp -d)}"',
    '    npm_config_cache="$cache_dir" npm_config_update_notifier=false npx --yes -p @happier-dev/stack@latest hapsta "$@"',
    '    return $?',
    '  fi',
    '  echo "Missing hapsta and npx. Install Node/npm or install @happier-dev/stack."',
    '  return 1',
    '}',
    '```',
    '',
  ].join('\n');
}
