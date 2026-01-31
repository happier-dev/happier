import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Returns an absolute path to this package's `bin/happys.mjs` if present.
 * This is the most reliable way to re-run Happy Stacks commands from an LLM prompt
 * when `npx` is unreliable (e.g. npm cache permission issues).
 */
export function resolveLocalHappyStacksHappysMjsPath() {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // scripts/utils/llm
    const root = resolve(here, '../../..'); // package root (contains bin/ and scripts/)
    const p = join(root, 'bin', 'happys.mjs');
    return existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

export function buildHappyStacksRunnerShellSnippet({ preferLocalBin = true } = {}) {
  const localBin = preferLocalBin ? resolveLocalHappyStacksHappysMjsPath() : '';
  const localClause = localBin
    ? [
        `HS_LOCAL_BIN=${JSON.stringify(localBin)}`,
        '  if [ -f "$HS_LOCAL_BIN" ]; then',
        '    node "$HS_LOCAL_BIN" "$@"',
        '    return $?',
        '  fi',
      ].join('\n')
    : '';

  return [
    'Happy Stacks command runner:',
    '- In the commands below, run `hs ...`.',
    '- This avoids `npx` flakiness by preferring a local `bin/happys.mjs` when available.',
    '',
    '```bash',
    'hs() {',
    '  # Prefer an installed `happys` if present.',
    '  if command -v happys >/dev/null 2>&1; then',
    '    happys "$@"',
    '    return $?',
    '  fi',
    localClause,
    '  # Fallback: npx. Work around broken ~/.npm perms by using a fresh writable cache dir.',
    '  if command -v npx >/dev/null 2>&1; then',
    '    local cache_dir',
    '    cache_dir="${HAPPY_STACKS_NPX_CACHE_DIR:-$(mktemp -d)}"',
    '    npm_config_cache="$cache_dir" npm_config_update_notifier=false npx --yes happy-stacks@latest "$@"',
    '    return $?',
    '  fi',
    '  echo "Missing happys and npx. Install Node/npm or install happy-stacks."',
    '  return 1',
    '}',
    '```',
    '',
  ].join('\n');
}

