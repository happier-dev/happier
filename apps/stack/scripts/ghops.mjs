import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function printHelp() {
  process.stdout.write(`
ghops: run GitHub CLI as the Happier bot

Usage:
  yarn ghops <gh-subcommand> [...args]

Required:
  HAPPIER_GITHUB_BOT_TOKEN   Fine-grained PAT for the bot account.

Optional:
  HAPPIER_GHOPS_GH_PATH      Path to the 'gh' executable (default: "gh")
  HAPPIER_GHOPS_CONFIG_DIR   Override GH_CONFIG_DIR (default: <repo>/.happier/local/ghops/gh)

Behavior:
  - Forces GH_TOKEN from HAPPIER_GITHUB_BOT_TOKEN (no fallback to stored gh auth)
  - Disables interactive prompts (GH_PROMPT_DISABLED=1)
  - Uses an isolated GH_CONFIG_DIR by default

Examples:
  yarn ghops api user
  yarn ghops api repos/happier-dev/happier/issues -f title="Bug" -f body="..."
  yarn ghops issue create --repo happier-dev/happier --title "Bug" --body "..."
  yarn ghops project item-add 1 --owner happier-dev --url https://github.com/happier-dev/happier/issues/43
`.trimStart());
}

function resolveRepoRoot(cwd) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (res.status !== 0) return resolve(cwd);
  const out = String(res.stdout ?? '').trim();
  return out ? resolve(out) : resolve(cwd);
}

function resolvePath(repoRoot, maybePath) {
  const trimmed = String(maybePath ?? '').trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? trimmed : resolve(repoRoot, trimmed);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args[0] === 'help') {
    printHelp();
    process.exit(0);
  }

  const token = String(process.env.HAPPIER_GITHUB_BOT_TOKEN ?? '').trim();
  if (!token) {
    process.stderr.write('[ghops] missing required env var: HAPPIER_GITHUB_BOT_TOKEN\n');
    process.exit(2);
  }

  const ghPath = String(process.env.HAPPIER_GHOPS_GH_PATH ?? '').trim() || 'gh';
  const repoRoot = resolveRepoRoot(process.cwd());
  const configDir =
    resolvePath(repoRoot, process.env.HAPPIER_GHOPS_CONFIG_DIR) ?? join(repoRoot, '.happier', 'local', 'ghops', 'gh');

  mkdirSync(configDir, { recursive: true });

  const env = {
    ...process.env,
    GH_TOKEN: token,
    GH_PROMPT_DISABLED: '1',
    GH_CONFIG_DIR: configDir,
  };

  const res = spawnSync(ghPath, args, { stdio: 'inherit', env });
  if (res.error) {
    process.stderr.write(`[ghops] failed to run gh (${ghPath}): ${String(res.error?.message ?? res.error)}\n`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

main();
