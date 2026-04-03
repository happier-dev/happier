import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const KEYCHAIN_SERVICE = 'happier-ghops';
const KEYCHAIN_ACCOUNT = 'github-bot';

function printHelp() {
  process.stdout.write(`
ghops: run GitHub CLI as the Happier bot

Usage:
  yarn ghops <gh-subcommand> [...args]
  yarn ghops set-token [--prompt] [--from-env] [--token <token>]

Required:
  HAPPIER_GITHUB_BOT_TOKEN   Fine-grained PAT for the bot account.

Optional:
  HAPPIER_GHOPS_GH_PATH      Path to the 'gh' executable (default: "gh")
  HAPPIER_GHOPS_SECURITY_PATH Path to the 'security' executable (default: "security", macOS only)
  HAPPIER_GHOPS_CONFIG_DIR   Override GH_CONFIG_DIR (default: <repo>/.happier/local/ghops/gh)

Behavior:
  - Forces GH_TOKEN from HAPPIER_GITHUB_BOT_TOKEN or (macOS) Keychain (no fallback to stored gh auth)
  - Disables interactive prompts (GH_PROMPT_DISABLED=1)
  - Uses an isolated GH_CONFIG_DIR by default

Examples:
  yarn ghops set-token --prompt
  HAPPIER_GITHUB_BOT_TOKEN=... yarn ghops set-token --from-env
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

function resolveSecurityPath() {
  return String(process.env.HAPPIER_GHOPS_SECURITY_PATH ?? '').trim() || 'security';
}

function readTokenFromMacKeychain() {
  if (process.platform !== 'darwin') return null;
  const securityPath = resolveSecurityPath();
  const res = spawnSync(
    securityPath,
    ['find-generic-password', '-w', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return null;
  const out = String(res.stdout ?? '').trim();
  return out ? out : null;
}

function resolveBotToken() {
  const envToken = String(process.env.HAPPIER_GITHUB_BOT_TOKEN ?? '').trim();
  if (envToken) return envToken;
  return readTokenFromMacKeychain();
}

function cmdSetToken(args) {
  if (process.platform !== 'darwin') {
    process.stderr.write('[ghops] set-token is only supported on macOS (Keychain)\n');
    process.stderr.write('[ghops] use HAPPIER_GITHUB_BOT_TOKEN env var instead\n');
    return 2;
  }

  const tokenFlagIdx = args.indexOf('--token');
  const tokenFromFlag =
    tokenFlagIdx >= 0 && typeof args[tokenFlagIdx + 1] === 'string' ? String(args[tokenFlagIdx + 1]).trim() : '';
  const tokenFromEnv = String(process.env.HAPPIER_GITHUB_BOT_TOKEN ?? '').trim();
  const wantsFromEnv = args.includes('--from-env');

  const securityPath = resolveSecurityPath();
  const securityArgs = ['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE];

  // NOTE: `security add-generic-password -w` without a value (as the last option) will prompt securely.
  if (tokenFromFlag) {
    securityArgs.push('-w', tokenFromFlag);
  } else if (wantsFromEnv && tokenFromEnv) {
    securityArgs.push('-w', tokenFromEnv);
  } else {
    securityArgs.push('-w');
  }

  const res = spawnSync(securityPath, securityArgs, { stdio: 'inherit' });
  if (res.error) {
    process.stderr.write(`[ghops] failed to run security (${securityPath}): ${String(res.error?.message ?? res.error)}\n`);
    return 1;
  }
  return res.status ?? 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args[0] === 'help') {
    printHelp();
    process.exit(0);
  }

  if (args[0] === 'set-token') {
    process.exit(cmdSetToken(args.slice(1)));
  }

  const token = resolveBotToken();
  if (!token) {
    process.stderr.write('[ghops] missing bot token (HAPPIER_GITHUB_BOT_TOKEN or macOS Keychain)\n');
    process.stderr.write('[ghops] tip: run `yarn ghops set-token --prompt` to store it in Keychain\n');
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
