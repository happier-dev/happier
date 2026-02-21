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
const scenario = process.env.HAPPIER_E2E_FAKE_CLAUDE_SCENARIO || process.env.HAPPY_E2E_FAKE_CLAUDE_SCENARIO || '';

function extractUserTextFromSdkMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const message = msg.message;
  if (!message || typeof message !== 'object') return null;
  if (message.role !== 'user') return null;

  const content = message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        const trimmed = part.trim();
        if (trimmed) parts.push(trimmed);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        const trimmed = part.text.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }

  return null;
}

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

  function emitSdk(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
    safeAppendJsonl(logPath, {
      type: 'sdk_stdout',
      invocationId,
      ts: Date.now(),
      messageType: obj?.type ?? null,
      messageSubtype: obj?.subtype ?? null,
    });
  }

  function createControlResponse(requestId, response) {
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        ...(response ? { response } : {}),
      },
    };
  }

  function createSystemInitMessage() {
    const mcpServers = Object.keys(mergedMcpServers || {}).map((name) => ({
      name,
      status: 'connected',
    }));

    return {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'project',
      claude_code_version: '0.0.0-fake',
      cwd: process.cwd(),
      tools: ['Bash(echo)'],
      mcp_servers: mcpServers,
      model: 'fake-claude',
      permissionMode: 'default',
      slash_commands: ['/help'],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: randomUUID(),
      session_id: sessionId,
    };
  }

  function createAssistantMessage(content) {
    return {
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId,
      message: {
        id: `fake-assistant-${turn}`,
        type: 'message',
        role: 'assistant',
        model: 'fake-claude',
        content,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
  }

  function createUserMessage(content) {
    return {
      type: 'user',
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId,
      message: { role: 'user', content },
    };
  }

  function createResultSuccess() {
    return {
      type: 'result',
      subtype: 'success',
      result: `FAKE_CLAUDE_DONE_${turn}`,
      num_turns: turn,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      stop_reason: null,
      uuid: randomUUID(),
      session_id: sessionId,
    };
  }

  for await (const line of rl) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Respond to Agent SDK control requests (initialize, set_permission_mode, etc).
    if (msg && typeof msg === 'object' && msg.type === 'control_request') {
      const requestId = typeof msg.request_id === 'string' ? msg.request_id : null;
      safeAppendJsonl(logPath, {
        type: 'sdk_stdin',
        invocationId,
        ts: Date.now(),
        messageType: msg?.type ?? null,
        controlSubtype: msg?.request?.subtype ?? null,
        requestId,
        hasUserText: false,
      });
      if (requestId) {
        emitSdk(createControlResponse(requestId));
      }
      continue;
    }

    const promptText = extractUserTextFromSdkMessage(msg);
    safeAppendJsonl(logPath, {
      type: 'sdk_stdin',
      invocationId,
      ts: Date.now(),
      messageType: msg?.type ?? null,
      messageRole: msg?.message?.role ?? null,
      hasUserText: Boolean(promptText),
    });
    if (!promptText) continue;

    if (!initialized) {
      initialized = true;
      emitSdk(createSystemInitMessage());
    }

    const now = Date.now();
    turn += 1;

    if (scenario === 'memory-hints-json') {
      const match = String(promptText).match(/OPENCLAW_MEMORY_SENTINEL_[A-Za-z0-9_-]+/);
      const sentinel = match ? match[0] : `FAKE_MEMORY_SENTINEL_${turn}`;

      const assistant = createAssistantMessage([
        {
          type: 'text',
          text: JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 0,
              seqTo: 0,
              createdAtFromMs: 0,
              createdAtToMs: 0,
              summary: `Summary shard for ${sentinel}`,
              keywords: ['openclaw', sentinel],
              entities: [],
              decisions: [],
            },
            synopsis: {
              v: 1,
              seqTo: 0,
              updatedAtMs: now,
              synopsis: `Session synopsis including ${sentinel}`,
            },
          }),
        },
      ]);

      emitSdk(assistant);
      emitSdk(createResultSuccess());
      continue;
    }

    if (scenario === 'taskoutput-sidechain') {
      const agentId = `agent_${turn}`;
      const taskToolUseId = `tool_task_${turn}`;
      const taskOutputToolUseId = `tool_taskoutput_${turn}`;

      const assistant = createAssistantMessage([
        {
          type: 'tool_use',
          id: taskToolUseId,
          name: 'Task',
          input: {
            description: `fake task ${turn}`,
            prompt: `do side work ${turn}`,
            subagent_type: 'general',
            run_in_background: true,
          },
        },
        {
          type: 'tool_use',
          id: taskOutputToolUseId,
          name: 'TaskOutput',
          input: { task_id: agentId, block: true, timeout: 2000 },
        },
      ]);

      const taskToolResult = createUserMessage([
        { type: 'tool_result', tool_use_id: taskToolUseId, content: `agentId: ${agentId}` },
      ]);

      const jsonl = [
        // Prompt root (string content) should be filtered out by Happier to avoid duplicate synthetic roots.
        {
          type: 'user',
          uuid: `u_prompt_${turn}`,
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId,
          userType: 'external',
          cwd: process.cwd(),
          version: '0.0.0',
          gitBranch: 'main',
          isSidechain: true,
          agentId,
          message: { role: 'user', content: `do side work ${turn}` },
        },
        {
          type: 'assistant',
          uuid: `u_assistant_${turn}`,
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId,
          userType: 'external',
          cwd: process.cwd(),
          version: '0.0.0',
          gitBranch: 'main',
          isSidechain: true,
          agentId,
          message: { role: 'assistant', content: [{ type: 'text', text: `FAKE_TASKOUTPUT_SIDECHAIN_OK_${turn}` }] },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')
        .concat('\n');

      const taskOutputToolResult = createUserMessage([
        { type: 'tool_result', tool_use_id: taskOutputToolUseId, content: jsonl },
      ]);

      emitSdk(assistant);
      emitSdk(taskToolResult);
      emitSdk(taskOutputToolResult);
      emitSdk(createResultSuccess());
      continue;
    }

    if (scenario === 'review-json') {
      const assistant = createAssistantMessage([
        {
          type: 'text',
          text: JSON.stringify({
            summary: `FAKE_REVIEW_SUMMARY_${turn}`,
            findings: [
              {
                id: `f_${turn}_1`,
                title: 'Fake finding',
                severity: 'low',
                category: 'style',
                summary: 'Fake finding summary',
                filePath: 'README.md',
                startLine: 1,
                endLine: 1,
                suggestion: 'No-op',
              },
            ],
          }),
        },
      ]);

      emitSdk(assistant);
      emitSdk(createResultSuccess());
      continue;
    }

    if (scenario === 'plan-json') {
      const assistant = createAssistantMessage([
        {
          type: 'text',
          text: JSON.stringify({
            summary: `FAKE_PLAN_SUMMARY_${turn}`,
            sections: [{ title: 'Phase 1', items: ['Do the thing', 'Verify'] }],
            risks: ['Fake risk'],
            milestones: [{ title: 'M1', details: 'Fake milestone' }],
            recommendedBackendId: 'claude',
          }),
        },
      ]);

      emitSdk(assistant);
      emitSdk(createResultSuccess());
      continue;
    }

    if (scenario === 'delegate-json') {
      const assistant = createAssistantMessage([
        {
          type: 'text',
          text: JSON.stringify({
            summary: `FAKE_DELEGATE_SUMMARY_${turn}`,
            deliverables: [{ id: `d_${turn}_1`, title: 'Fake deliverable', details: 'Fake details' }],
          }),
        },
      ]);

      emitSdk(assistant);
      emitSdk(createResultSuccess());
      continue;
    }

    if (scenario === 'commit-message-json') {
      const assistant = createAssistantMessage([
        {
          type: 'text',
          text: JSON.stringify({
            title: 'feat: ephemeral commit message',
            body: '',
            message: 'feat: ephemeral commit message',
            confidence: 1,
          }),
        },
      ]);

      emitSdk(assistant);
      emitSdk(createResultSuccess());
      continue;
    }

    const assistant = createAssistantMessage([{ type: 'text', text: `FAKE_CLAUDE_OK_${turn}` }]);

    emitSdk(assistant);
    emitSdk(createResultSuccess());
  }

  rl.close();
  safeAppendJsonl(logPath, { type: 'sdk_exited', invocationId, ts: Date.now(), turns: turn });
  process.exit(0);
}

async function runPrintStreamJsonAndExit() {
  const systemInit = {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'project',
    claude_code_version: '0.0.0-fake',
    cwd: process.cwd(),
    tools: ['Bash(echo)'],
    mcp_servers: [],
    model: 'fake-claude',
    permissionMode: 'default',
    slash_commands: ['/help'],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: sessionId,
  };
  const assistant = {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
    message: {
      id: 'fake-print-assistant-1',
      type: 'message',
      role: 'assistant',
      model: 'fake-claude',
      content: [{ type: 'text', text: 'FAKE_CLAUDE_PRINT_OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  const result = {
    type: 'result',
    subtype: 'success',
    result: 'FAKE_CLAUDE_PRINT_DONE',
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    stop_reason: null,
    uuid: randomUUID(),
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
