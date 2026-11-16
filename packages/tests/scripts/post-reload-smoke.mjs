#!/usr/bin/env node
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stack = 'agent-qa-servers-deploy';

export const usage = `Usage (from the repository root; uses the running stack, never reloads):
  node packages/tests/scripts/post-reload-smoke.mjs \\
    --identity <named-qa-identity> --account-id <expected-account-id> \\
    --machine-id <machine-id> --path <existing-machine-directory> \\
    --agent <agent-id> --model <model-id> --reasoning-effort <effort> \\
    --auth <native|cs:selector> [--provider-connection <connection-id>] \\
    [--environment-id <owned-fixture-environment-id>]

Runs identity verification, Connected Account and Provider reads, Environment
inventory, then one tiny real Agent turn through session create/wait/history.
An explicit Environment adds definition and receipt reads. Only the new Session
is stopped and archived. No cloud resources are created or changed.
Choose an authorized contributor Muse model at minimal effort for QA; gateway
rows use Codex/OpenCode and their explicit Provider connection. There are no
retries (including quota failures), custom wait budgets, auth changes or reloads.
Stdout is a secret-free JSON result; exit 1 means a failed check, 2 invalid input.
Session wait uses the CLI owner's default. Redirect stdout to retain evidence.
`;

export function parseSmokeArgs(argv) {
  const names = ['identity', 'account-id', 'machine-id', 'path', 'agent', 'model',
    'reasoning-effort', 'auth', 'provider-connection', 'environment-id'];
  const { values } = parseArgs({ args: argv, options: {
    ...Object.fromEntries(names.map(name => [name, { type: 'string' }])),
    help: { type: 'boolean' },
  } });
  if (values.help) return null;
  for (const name of names.slice(0, 8)) {
    if (!values[name]?.trim()) throw new Error(`missing_${name.replaceAll('-', '_')}`);
  }
  if (values.identity.trim().toLowerCase() === 'default') throw new Error('named_identity_required');
  if (values.auth !== 'native' && !values.auth.startsWith('cs:')) throw new Error('explicit_auth_required');
  return values;
}

function failure(code) {
  return new Error(/^[a-zA-Z0-9_.:-]+$/.test(code ?? '') ? code : 'invalid_cli_result');
}

async function cli(config, args, kind) {
  // Reuse the existing cross-platform PTY adapter: repo_local's live remote CLI
  // needs a terminal. Child diagnostics stay private, never forwarded to stdout.
  const result = await new Promise((resolveResult, reject) => {
    const child = childProcess.spawn(process.execPath, [
      'packages/tests/scripts/plugin-platform/run-command-in-pty.mjs', '--',
      process.execPath, 'apps/stack/scripts/repo_local.mjs', 'stack', 'happier', stack,
      `--identity=${config.identity}`, '--', ...args, '--json',
    ], { cwd: repoRoot, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.once('error', () => reject(failure('cli_launch_failed')));
    child.once('close', (exitCode, signal) => resolveResult({ output, exitCode, signal }));
  });
  const output = stripVTControlCharacters(result.output).trim();
  const jsonEnd = output.lastIndexOf('}') + 1;
  let envelope;
  // Stack diagnostics can precede the final, possibly multiline CLI envelope.
  for (let index = output.lastIndexOf('{'); index >= 0; index = output.lastIndexOf('{', index - 1)) {
    try {
      const candidate = JSON.parse(output.slice(index, jsonEnd));
      if (candidate?.v === 1) { envelope = candidate; break; }
    } catch { /* A nested object or diagnostic is not the final envelope. */ }
    if (index === 0) break;
  }
  if (!envelope) throw failure('cli_json_envelope_missing');
  if (envelope.ok !== true) throw failure(envelope.error?.code);
  if (result.exitCode !== 0 || result.signal) throw failure('cli_process_failed');
  if (envelope.kind !== kind) throw failure('cli_envelope_kind_mismatch');
  if (envelope.data?.ok === false) throw failure(envelope.data.errorCode ?? envelope.data.error);
  return envelope.data;
}

export async function runSmoke(config) {
  const report = { stack, identity: config.identity, accountId: config['account-id'],
    machineId: config['machine-id'], checks: [], ok: false };
  async function check(name, effect) {
    try {
      const details = await effect();
      report.checks.push({ name, ok: true, ...details });
      return true;
    } catch (error) {
      report.checks.push({ name, ok: false, code: failure(error.message).message });
      return false;
    }
  }
  let serverId;
  const authenticated = await check('identity', async () => {
    const data = await cli(config, ['auth', 'status'], 'auth_status');
    if (data?.authenticated !== true) throw failure('not_authenticated');
    if (data.accountId !== config['account-id']) throw failure('account_identity_mismatch');
    if (typeof data.serverId !== 'string' || !data.serverId) throw failure('server_identity_missing');
    serverId = data.serverId;
    return { serverId };
  });
  if (!authenticated) return report;
  const invoke = (action, input) => cli(config, ['actions', 'invoke', action,
    '--input-json', JSON.stringify(input), '--machine-id', config['machine-id']], 'actions_invoke');
  await check('connected-accounts', async () => {
    const data = await invoke('connectedServices.accounts.list', {});
    if (!Array.isArray(data?.accounts) || !Array.isArray(data.pools)) throw failure('connected_accounts_missing');
    return { accounts: data.accounts.length, pools: data.pools.length };
  });
  await check('providers', async () => {
    const data = await cli(config, ['providers', 'list'], 'providers_list');
    if (!Array.isArray(data?.connections)) throw failure('provider_connections_missing');
    if (config['provider-connection'] && !data.connections.some(row => row.connectionId === config['provider-connection'])) {
      throw failure('selected_provider_connection_missing');
    }
    return { connections: data.connections.length };
  });
  await check('environment-inventory', async () => {
    const data = await invoke('deployments.environments.list', { serverId });
    if (!Array.isArray(data?.items)) throw failure('environment_inventory_missing');
    return { environments: data.items.length, hasNextPage: data.nextCursor !== null };
  });
  if (config['environment-id']) {
    const address = { serverId, environmentId: config['environment-id'] };
    await check('environment-definition', async () => {
      const data = await invoke('deployments.environments.get', address);
      if (data?.environment?.id !== address.environmentId || !Array.isArray(data.targetLinks)) {
        throw failure('environment_definition_missing');
      }
      return { targetLinks: data.targetLinks.length };
    });
    await check('environment-receipts', async () => {
      const data = await invoke('deployments.receipts.list', address);
      if (!Array.isArray(data?.items)) throw failure('environment_receipts_missing');
      return { receipts: data.items.length, hasNextPage: data.nextCursor !== null };
    });
  }

  let sessionId;
  const reply = `JOURNEY_SMOKE_${randomUUID()}`;
  try {
    const created = await check('agent-create', async () => {
      const data = await cli(config, ['session', 'create', '--machine-id', config['machine-id'],
        '--path', config.path, '--agent', config.agent, '--model', config.model,
        '--reasoning-effort', config['reasoning-effort'], '--auth', config.auth,
        ...(config['provider-connection'] ? ['--provider-connection', config['provider-connection']] : []),
        '--title', 'Post-reload journey smoke', '--permission-mode', 'read-only',
        '--prompt', `No tools or file changes. Reply with exactly ${reply}`], 'session_create');
      sessionId = data?.session?.id;
      if (typeof sessionId !== 'string' || !sessionId) throw failure('created_session_missing');
      report.sessionId = sessionId;
      if (data.initialInput?.status !== 'accepted') throw failure('initial_prompt_not_accepted');
      return { sessionId };
    });
    if (created) {
      await check('agent-settled-turn', async () => {
        const waited = await cli(config, ['session', 'wait', sessionId], 'session_wait');
        if (waited?.sessionId !== sessionId || waited.idle !== true) throw failure('session_not_idle');
        const history = await cli(config, ['session', 'history', sessionId,
          '--machine-id', config['machine-id']], 'session_history');
        if (history?.sessionId !== sessionId || !Array.isArray(history.messages)) throw failure('transcript_missing');
        if (history.messages.some(row => row.kind === 'turn_failed' || row.kind === 'turn_aborted')) {
          throw failure('agent_turn_failed');
        }
        if (!history.messages.some(row => (row.role === 'agent' || row.role === 'assistant')
          && typeof row.text === 'string' && row.text.trim() === reply)) {
          throw failure('agent_reply_missing');
        }
        return { messages: history.messages.length, replyObserved: true };
      });
    }
  } finally {
    if (sessionId) {
      await check('session-stop', async () => {
        const data = await cli(config, ['session', 'stop', sessionId], 'session_stop');
        if (data?.sessionId !== sessionId || (data.stopped !== true && data.stopOutcome?.status !== 'already_stopped')) {
          throw failure('session_stop_unconfirmed');
        }
      });
      await check('session-archive', async () => {
        const data = await cli(config, ['session', 'archive', sessionId], 'session_archive');
        if (data?.sessionId !== sessionId || typeof data.archivedAt !== 'number') throw failure('session_archive_unconfirmed');
      });
    }
  }
  report.ok = report.checks.every(row => row.ok);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = parseSmokeArgs(process.argv.slice(2));
    if (!config) process.stdout.write(usage);
    else {
      const result = await runSmoke(config);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${failure(error.message).message}\n${usage}`);
    process.exitCode = 2;
  }
}
