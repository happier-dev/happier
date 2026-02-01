import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Returns an absolute path to this package's `bin/hstack.mjs` if present.
 * This is the most reliable way to re-run hstack commands from an LLM prompt
 * when `npx` is unreliable (e.g. npm cache permission issues).
 */
export function resolveLocalhstackBinPath() {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // scripts/utils/llm
    const root = resolve(here, '../../..'); // package root (contains bin/ and scripts/)
    const p = join(root, 'bin', 'hstack.mjs');
    return existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

export function buildhstackRunnerShellSnippet({ preferLocalBin = true } = {}) {
  const localBin = preferLocalBin ? resolveLocalhstackBinPath() : '';
  const localClause = localBin
    ? [
        `hstack_LOCAL_BIN=${JSON.stringify(localBin)}`,
        '  if [ -f "$hstack_LOCAL_BIN" ]; then',
        '    node "$hstack_LOCAL_BIN" "$@"',
        '    return $?',
        '  fi',
      ].join('\n')
    : '';

  return [
    'hstack (Happier Stack) command runner:',
    '- In the commands below, run `hstack ...`.',
    '- This avoids `npx` flakiness by preferring a local `bin/hstack.mjs` when available.',
    '',
    '```bash',
    'hstack() {',
    '  # Prefer an installed `hstack` if present.',
    '  if command -v hstack >/dev/null 2>&1; then',
    '    command hstack "$@"',
    '    return $?',
    '  fi',
    localClause,
    '  # Fallback: npx. Work around broken ~/.npm perms by using a fresh writable cache dir.',
    '  if command -v npx >/dev/null 2>&1; then',
    '    local cache_dir',
    '    cache_dir="${HAPPIER_STACK_NPX_CACHE_DIR:-$(mktemp -d)}"',
    '    npm_config_cache="$cache_dir" npm_config_update_notifier=false npx --yes -p @happier-dev/stack@latest hstack "$@"',
    '    return $?',
    '  fi',
    '  echo "Missing hstack and npx. Install Node/npm or install @happier-dev/stack."',
    '  return 1',
    '}',
    '```',
    '',
  ].join('\n');
}
