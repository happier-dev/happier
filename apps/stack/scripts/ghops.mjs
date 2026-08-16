import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { expandHome } from './utils/paths/canonical_home.mjs';
import { deleteKeychainBundle } from '../../../scripts/pipeline/secrets/delete-keychain-bundle.mjs';
import { readKeychainBundle } from '../../../scripts/pipeline/secrets/read-keychain-bundle.mjs';
import { writeKeychainBundle } from '../../../scripts/pipeline/secrets/write-keychain-bundle.mjs';

const BOT_TOKEN_ENV_KEY = 'HAPPIER_GITHUB_BOT_TOKEN';
const BOT_LOGIN = 'happier-bot';
const KEYCHAIN_SERVICE = 'happier/ghops';
const KEYCHAIN_ACCOUNT = BOT_LOGIN;

function printHelp() {
  process.stdout.write(`
ghops: run GitHub CLI as the Happier bot

Usage:
  yarn ghops <gh-subcommand> [...args]

Required:
  Bot token from HAPPIER_GITHUB_BOT_TOKEN, or macOS Keychain after auth store.
  Issue mutations require repository permission: Issues (read and write).

Optional:
  HAPPIER_GHOPS_GH_PATH      Path to the 'gh' executable (default: "gh")
  HAPPIER_GHOPS_CONFIG_DIR   Override GH_CONFIG_DIR (default: <repo>/.happier/local/ghops/gh)

Behavior:
  - Prefers HAPPIER_GITHUB_BOT_TOKEN, then macOS Keychain service '${KEYCHAIN_SERVICE}'
  - Forces GH_TOKEN from the resolved bot token (no fallback to stored gh auth)
  - Disables interactive prompts (GH_PROMPT_DISABLED=1)
  - Uses an isolated GH_CONFIG_DIR by default

Authentication:
  yarn ghops auth store      Validate and store the happier-bot token in macOS Keychain
  yarn ghops auth status     Validate the resolved bot identity and show its source
  yarn ghops auth clear      Remove the stored macOS Keychain token

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

function resolvePath(repoRoot, maybePath, env = process.env) {
  const trimmed = String(maybePath ?? '').trim();
  if (!trimmed) return null;
  const expanded = expandHome(trimmed, env);
  return isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
}

function isKeychainNotFoundError(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const message = typeof error?.message === 'string' ? error.message : String(error ?? '');
  const haystack = `${stderr}\n${message}`.toLowerCase();
  return haystack.includes('the specified item could not be found')
    || haystack.includes('secitemcopymatching')
    || haystack.includes('could not be found in the keychain');
}

function readStoredBotToken() {
  if (process.platform !== 'darwin') return '';
  try {
    const bundle = readKeychainBundle({ service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
    return String(bundle[BOT_TOKEN_ENV_KEY] ?? '').trim();
  } catch (error) {
    if (isKeychainNotFoundError(error)) return '';
    throw error;
  }
}

function resolveBotToken() {
  const environmentToken = String(process.env[BOT_TOKEN_ENV_KEY] ?? '').trim();
  if (environmentToken) return { token: environmentToken, source: 'environment' };
  const keychainToken = readStoredBotToken();
  if (keychainToken) return { token: keychainToken, source: 'keychain' };
  return { token: '', source: 'missing' };
}

function buildGhEnvironment(token, configDir) {
  return {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: '',
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GH_CONFIG_DIR: configDir,
  };
}

function validateBotIdentity({ ghPath, token, configDir }) {
  const result = spawnSync(ghPath, ['api', 'user', '--jq', '.login'], {
    encoding: 'utf8',
    env: buildGhEnvironment(token, configDir),
  });
  if (result.error || result.status !== 0) {
    throw new Error('GitHub rejected the provided bot token.');
  }
  const login = String(result.stdout ?? '').trim();
  if (login !== BOT_LOGIN) {
    throw new Error(`Expected GitHub identity '${BOT_LOGIN}', received '${login || 'unknown'}'.`);
  }
  return login;
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Set ${BOT_TOKEN_ENV_KEY} or run auth store in an interactive terminal.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const output = rl.output ?? process.stdout;
  const originalWrite = rl._writeToOutput?.bind(rl);
  let muted = false;
  if (originalWrite) {
    rl._writeToOutput = (text) => {
      if (!muted) originalWrite(text);
    };
  }
  try {
    return await new Promise((resolvePrompt, rejectPrompt) => {
      output.write(label);
      muted = true;
      rl.once('SIGINT', () => {
        muted = false;
        output.write('\n');
        rl.close();
        rejectPrompt(new Error('Cancelled.'));
      });
      rl.question('', (answer) => {
        muted = false;
        output.write('\n');
        rl.close();
        resolvePrompt(String(answer ?? '').trim());
      });
    });
  } finally {
    muted = false;
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === 'help'))) {
    printHelp();
    return 0;
  }

  const repoRoot = resolveRepoRoot(process.cwd());
  const ghPath = resolvePath(repoRoot, process.env.HAPPIER_GHOPS_GH_PATH, process.env) || 'gh';
  const configDir =
    resolvePath(repoRoot, process.env.HAPPIER_GHOPS_CONFIG_DIR, process.env) ?? join(repoRoot, '.happier', 'local', 'ghops', 'gh');

  mkdirSync(configDir, { recursive: true });

  if (args[0] === 'auth' && args[1] === 'store') {
    if (process.platform !== 'darwin') {
      throw new Error(`macOS Keychain storage is unavailable; continue using ${BOT_TOKEN_ENV_KEY}.`);
    }
    const environmentToken = String(process.env[BOT_TOKEN_ENV_KEY] ?? '').trim();
    const token = environmentToken || await promptSecret('Happier bot GitHub token: ');
    if (!token) throw new Error('A non-empty bot token is required.');
    const login = validateBotIdentity({ ghPath, token, configDir });
    writeKeychainBundle({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT,
      bundle: { [BOT_TOKEN_ENV_KEY]: token },
    });
    process.stdout.write(`[ghops] stored macOS Keychain credential for ${login}.\n`);
    return 0;
  }

  if (args[0] === 'auth' && args[1] === 'clear') {
    if (process.platform !== 'darwin') {
      throw new Error(`macOS Keychain storage is unavailable; continue using ${BOT_TOKEN_ENV_KEY}.`);
    }
    try {
      deleteKeychainBundle({ service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
      process.stdout.write('[ghops] removed the stored macOS Keychain credential.\n');
    } catch (error) {
      if (!isKeychainNotFoundError(error)) throw error;
      process.stdout.write('[ghops] no stored macOS Keychain credential was found.\n');
    }
    if (String(process.env[BOT_TOKEN_ENV_KEY] ?? '').trim()) {
      process.stdout.write(`[ghops] ${BOT_TOKEN_ENV_KEY} remains active as an environment override.\n`);
    }
    return 0;
  }

  const resolved = resolveBotToken();
  if (!resolved.token) {
    const keychainHint = process.platform === 'darwin' ? ' or run `yarn ghops auth store`' : '';
    process.stderr.write(`[ghops] missing ${BOT_TOKEN_ENV_KEY}; set it${keychainHint}.\n`);
    return 2;
  }

  if (args[0] === 'auth' && args[1] === 'status') {
    const login = validateBotIdentity({ ghPath, token: resolved.token, configDir });
    process.stdout.write(`[ghops] authenticated as ${login} via ${resolved.source}.\n`);
    return 0;
  }

  if (args[0] === 'auth') {
    throw new Error('Unknown auth command. Use auth store, auth status, or auth clear.');
  }

  validateBotIdentity({ ghPath, token: resolved.token, configDir });

  const res = spawnSync(ghPath, args, {
    stdio: 'inherit',
    env: buildGhEnvironment(resolved.token, configDir),
  });
  if (res.error) {
    throw new Error(`Failed to run gh (${ghPath}): ${String(res.error?.message ?? res.error)}`);
  }
  return res.status ?? 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`[ghops] ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
}
