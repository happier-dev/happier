import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
ghops: run GitHub operations as the Happier bot

Usage:
  yarn ghops <gh-subcommand> [...args]
  yarn ghops git push --repo OWNER/REPO --source REVISION --target refs/heads/BRANCH [--force-with-lease EXPECTED_SHA]

Required:
  Bot token from HAPPIER_GITHUB_BOT_TOKEN, or macOS Keychain after auth store.
  Issue mutations require repository permission: Issues (read and write).
  Git pushes require repository permission: Contents (read and write) and write access to the target branch.

Optional:
  HAPPIER_GHOPS_GH_PATH      Path to the 'gh' executable (default: "gh")
  HAPPIER_GHOPS_GIT_PATH     Path to the 'git' executable (default: "git")
  HAPPIER_GHOPS_CONFIG_DIR   Override GH_CONFIG_DIR (default: <repo>/.happier/local/ghops/gh)

Behavior:
  - Prefers HAPPIER_GITHUB_BOT_TOKEN, then macOS Keychain service '${KEYCHAIN_SERVICE}'
  - Forces GH_TOKEN from the resolved bot token (no fallback to stored gh auth)
  - Disables interactive prompts (GH_PROMPT_DISABLED=1)
  - Uses an isolated GH_CONFIG_DIR by default
  - Authenticates explicit Git pushes as happier-bot without changing remotes or Git credential configuration
  - Disables repository hooks for bot-authenticated pushes so they cannot inherit the temporary credential header

Authentication:
  yarn ghops auth store      Validate and store the happier-bot token in macOS Keychain
  yarn ghops auth status     Validate the resolved bot identity and show its source
  yarn ghops auth clear      Remove the stored macOS Keychain token

Examples:
  yarn ghops api user
  yarn ghops api repos/happier-dev/happier/issues -f title="Bug" -f body="..."
  yarn ghops issue create --repo happier-dev/happier --title "Bug" --body "..."
  yarn ghops project item-add 1 --owner happier-dev --url https://github.com/happier-dev/happier/issues/43
  yarn ghops git push --repo happier-dev/happier --source HEAD --target refs/heads/my-branch
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

function parseGitPushArgs(args) {
  const values = new Map();
  const allowed = new Set(['--repo', '--source', '--target', '--force-with-lease']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.has(key) || value === undefined || values.has(key)) {
      throw new Error('Usage: ghops git push --repo OWNER/REPO --source REVISION --target refs/heads/BRANCH [--force-with-lease EXPECTED_SHA]');
    }
    values.set(key, value);
  }

  const repo = String(values.get('--repo') ?? '');
  const source = String(values.get('--source') ?? '');
  const target = String(values.get('--target') ?? '');
  const expectedLease = values.has('--force-with-lease')
    ? String(values.get('--force-with-lease'))
    : null;

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('Bot Git pushes require an explicit GitHub OWNER/REPO target.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source) || source.includes('..') || source.includes('@{')) {
    throw new Error('Bot Git pushes require a safe explicit source revision.');
  }
  if (!target.startsWith('refs/heads/')) {
    throw new Error('Bot Git pushes may target only an explicit refs/heads/* branch.');
  }
  if (expectedLease !== null && !/^[0-9a-f]{40,64}$/i.test(expectedLease)) {
    throw new Error('--force-with-lease requires the exact expected remote commit SHA.');
  }

  return { repo, source, target, expectedLease };
}

function buildBotGitEnvironment({ token, hooksDir }) {
  const environment = { ...process.env };
  delete environment[BOT_TOKEN_ENV_KEY];
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  delete environment.GIT_TRACE;
  delete environment.GIT_TRACE_CURL;
  delete environment.GIT_CURL_VERBOSE;
  delete environment.GIT_CONFIG;
  delete environment.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete environment[key];
  }

  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GCM_INTERACTIVE = 'Never';
  environment.GIT_CONFIG_COUNT = '4';
  environment.GIT_CONFIG_KEY_0 = 'http.extraHeader';
  environment.GIT_CONFIG_VALUE_0 = '';
  environment.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraHeader';
  environment.GIT_CONFIG_VALUE_1 = `Authorization: Basic ${Buffer.from(`${BOT_LOGIN}:${token}`, 'utf8').toString('base64')}`;
  environment.GIT_CONFIG_KEY_2 = 'credential.helper';
  environment.GIT_CONFIG_VALUE_2 = '';
  environment.GIT_CONFIG_KEY_3 = 'core.hooksPath';
  environment.GIT_CONFIG_VALUE_3 = hooksDir;
  return environment;
}

function runBotGitPush({ gitPath, token, repo, source, target, expectedLease }) {
  const hooksDir = mkdtempSync(join(tmpdir(), 'happier-ghops-empty-hooks-'));
  try {
    const environment = buildBotGitEnvironment({ token, hooksDir });
    const refCheck = spawnSync(gitPath, ['check-ref-format', target], { encoding: 'utf8', env: environment });
    if (refCheck.error || refCheck.status !== 0) {
      throw new Error(`Invalid target branch ref '${target}'.`);
    }

    const sourceResult = spawnSync(gitPath, ['rev-parse', '--verify', `${source}^{commit}`], {
      encoding: 'utf8',
      env: environment,
    });
    const sourceSha = String(sourceResult.stdout ?? '').trim();
    if (sourceResult.error || sourceResult.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(sourceSha)) {
      throw new Error(`Unable to resolve source revision '${source}' to a commit.`);
    }

    const remote = `https://github.com/${repo}.git`;
    const leaseArgs = expectedLease === null
      ? []
      : [`--force-with-lease=${target}:${expectedLease}`];
    const pushResult = spawnSync(gitPath, [
      'push',
      ...leaseArgs,
      remote,
      `${sourceSha}:${target}`,
    ], {
      stdio: 'inherit',
      env: environment,
    });
    if (pushResult.error || pushResult.status !== 0) {
      throw new Error(`Bot-authenticated Git push failed for ${repo}:${target}.`);
    }

    const verifyResult = spawnSync(gitPath, ['ls-remote', '--refs', remote, target], {
      encoding: 'utf8',
      env: environment,
    });
    const remoteSha = String(verifyResult.stdout ?? '').trim().split(/\s+/, 1)[0] ?? '';
    if (verifyResult.error || verifyResult.status !== 0 || remoteSha.toLowerCase() !== sourceSha.toLowerCase()) {
      throw new Error(`Push completed but ${repo}:${target} did not resolve to ${sourceSha}.`);
    }

    process.stdout.write(`[ghops] pushed ${sourceSha} to ${repo}:${target} as ${BOT_LOGIN}.\n`);
    return 0;
  } finally {
    rmSync(hooksDir, { recursive: true, force: true });
  }
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
  const gitPath = resolvePath(repoRoot, process.env.HAPPIER_GHOPS_GIT_PATH, process.env) || 'git';
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

  if (args[0] === 'git') {
    if (args[1] !== 'push') {
      throw new Error('Only `ghops git push` is supported.');
    }
    return runBotGitPush({
      gitPath,
      token: resolved.token,
      ...parseGitPushArgs(args.slice(2)),
    });
  }

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
