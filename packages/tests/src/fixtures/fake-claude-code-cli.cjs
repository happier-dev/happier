/**
 * Fake Claude Code CLI for deterministic Happier e2e tests.
 *
 * This is intentionally minimal and only implements the behaviors our e2e suite needs:
 * - Parses `--settings` and triggers the SessionStart hook forwarder with JSON on stdin.
 * - Records invocations (argv + parsed --mcp-config) to a JSONL log for assertions.
 * - In SDK mode (`--output-format stream-json --input-format stream-json`), reads user messages from stdin until EOF,
 *   and for each user turn emits a small stream-json transcript (system:init once → assistant → result).
 * - In local/interactive mode, stays alive until SIGTERM (mode-switch abort).
 *
 * This file is used via `HAPPIER_CLAUDE_PATH` so the real user-installed Claude Code is not required.
 */

const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const {
  findArgValue,
  mergeMcpServers,
  parseHookForwarderCommand,
  parseMcpConfigs,
  runHookForwarder,
  safeAppendJsonl,
} = require('./fake-claude-code-cli.helpers.cjs');

const argv = process.argv.slice(2);
const invocationId =
  process.env.HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID ||
  process.env.HAPPY_E2E_FAKE_CLAUDE_INVOCATION_ID ||
  `fake-claude-${randomUUID()}`;
const sessionId =
  process.env.HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID ||
  process.env.HAPPY_E2E_FAKE_CLAUDE_SESSION_ID ||
  `fake-claude-session-${randomUUID()}`;
const logPath = process.env.HAPPIER_E2E_FAKE_CLAUDE_LOG || process.env.HAPPY_E2E_FAKE_CLAUDE_LOG || '';

const mcpConfigs = parseMcpConfigs(argv);
const mergedMcpServers = mergeMcpServers(mcpConfigs);

const outputFormat = findArgValue(argv, '--output-format');
const inputFormat = findArgValue(argv, '--input-format');
const isStreamJson = outputFormat === 'stream-json';
const isSdkStreamJson = isStreamJson && inputFormat === 'stream-json';
const hasPrint = argv.includes('--print');
const mode = isSdkStreamJson ? 'sdk' : 'local';

safeAppendJsonl(logPath, {
  type: 'invocation',
  invocationId,
  mode,
  pid: process.pid,
  ts: Date.now(),
  cwd: process.cwd(),
  argv,
  mcpConfigs,
  mergedMcpServers,
});

const settingsPath = findArgValue(argv, '--settings');
const hook = parseHookForwarderCommand(settingsPath);
void runHookForwarder({
  hook,
  payload: {
    session_id: sessionId,
    transcript_path: path.join(process.cwd(), `${sessionId}.jsonl`),
  },
  logPath,
  invocationId,
});

async function runSdkStreamUntilEof() {
  const rl = readline.createInterface({ input: process.stdin });
  let initialized = false;
  let turn = 0;

  const systemInit = {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Bash(echo)'],
    slash_commands: ['/help'],
  };

  for await (const line of rl) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!msg || msg.type !== 'user') continue;

    if (!initialized) {
      initialized = true;
      process.stdout.write(`${JSON.stringify(systemInit)}\n`);
    }

    const now = Date.now();
    turn += 1;
    const assistant = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `FAKE_CLAUDE_OK_${turn}` }] },
    };
    const result = {
      type: 'result',
      subtype: 'success',
      result: `FAKE_CLAUDE_DONE_${turn}`,
      num_turns: turn,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      duration_ms: Math.max(1, Date.now() - now),
      duration_api_ms: 1,
      is_error: false,
      session_id: sessionId,
    };

    process.stdout.write(`${JSON.stringify(assistant)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  rl.close();
  safeAppendJsonl(logPath, { type: 'sdk_exited', invocationId, ts: Date.now(), turns: turn });
  process.exit(0);
}

async function runPrintStreamJsonAndExit() {
  const now = Date.now();
  const systemInit = {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Bash(echo)'],
    slash_commands: ['/help'],
  };
  const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FAKE_CLAUDE_PRINT_OK' }] } };
  const result = {
    type: 'result',
    subtype: 'success',
    result: 'FAKE_CLAUDE_PRINT_DONE',
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0,
    duration_ms: Math.max(1, Date.now() - now),
    duration_api_ms: 1,
    is_error: false,
    session_id: sessionId,
  };

  process.stdout.write(`${JSON.stringify(systemInit)}\n`);
  process.stdout.write(`${JSON.stringify(assistant)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (isSdkStreamJson) {
  void runSdkStreamUntilEof();
} else if (isStreamJson && hasPrint) {
  void runPrintStreamJsonAndExit();
} else {
  // Local/interactive: keep the process alive until the parent aborts us (SIGTERM on mode switch).
  // Avoid printing anything on stdout, as local mode uses `inherit`.
  const interval = setInterval(() => {}, 1000);
  const stop = () => {
    clearInterval(interval);
    safeAppendJsonl(logPath, { type: 'local_exited', invocationId, ts: Date.now() });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
