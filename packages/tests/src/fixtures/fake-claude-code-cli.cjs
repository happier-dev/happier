/**
 * Fake Claude Code CLI for deterministic Happier e2e tests.
 *
 * This is intentionally minimal and only implements the behaviors our e2e suite needs:
 * - Parses `--settings` and triggers the SessionStart hook forwarder with JSON on stdin.
 * - Records invocations (argv + parsed --mcp-config) to a JSONL log for assertions.
 * - In SDK mode (`--output-format stream-json --input-format stream-json`), reads user messages from stdin until EOF,
 *   and for each user turn emits a small stream-json transcript (system:init once → assistant → result).
 * - In local/interactive mode, appends deterministic user → assistant/end_turn transcript
 *   records for submitted stdin lines, can optionally append signal-file driven turns, then
 *   stays alive until SIGTERM (mode-switch abort).
 *
 * This file is used via `HAPPIER_CLAUDE_PATH` so the real user-installed Claude Code is not required.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const readline = require('node:readline');
const { createHash, randomUUID } = require('node:crypto');
const { resolveClaudeProjectId } = require('../testkit/claudeProjectId.cjs');
const {
  findArgValue,
  mergeMcpServers,
  parseHookForwarderCommand,
  parseMcpConfigs,
  runHookForwarder,
  safeAppendJsonl,
} = require('./fake-claude-code-cli.helpers.cjs');
const { buildWorkflowSpec } = require('./fake-claude-workflow-transcript.cjs');

const argv = process.argv.slice(2);
const invocationId =
  process.env.HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID ||
  process.env.HAPPY_E2E_FAKE_CLAUDE_INVOCATION_ID ||
  `fake-claude-${randomUUID()}`;
const resumeSessionId = findArgValue(argv, '--resume');
const sessionId =
  process.env.HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID ||
  process.env.HAPPY_E2E_FAKE_CLAUDE_SESSION_ID ||
  (typeof resumeSessionId === 'string' && resumeSessionId.length > 0 ? resumeSessionId : '') ||
  `fake-claude-session-${randomUUID()}`;
const processNonce = randomUUID();
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
const localActiveTurnEnabled = ['1', 'true', 'yes'].includes(
  String(process.env.HAPPIER_E2E_FAKE_CLAUDE_LOCAL_ACTIVE_TURN || '').trim().toLowerCase(),
);
const localActiveTurnStartSignalPath = String(
  process.env.HAPPIER_E2E_FAKE_CLAUDE_LOCAL_START_SIGNAL || '',
).trim();
const localActiveTurnCompleteSignalPath = String(
  process.env.HAPPIER_E2E_FAKE_CLAUDE_LOCAL_COMPLETE_SIGNAL || '',
).trim();
const runtimeActivityTerminalSignalPath = String(
  process.env.HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_ACTIVITY_TERMINAL_SIGNAL || '',
).trim();

// `goal-status-attachment` scenario (T3): in local/unified-terminal mode, when a
// signal file appears the fake CLI appends a Claude-native `goal_status`
// transcript `attachment` record (the exact shape the unified-terminal launcher
// tails and routes through `routeClaudeAttachment` → goal source → metadata).
// The signal file's contents (if any) become the goal `condition`/objective so a
// test can correlate the emitted goal with what it requested.
const goalStatusActiveSignalPath = String(
  process.env.HAPPIER_E2E_FAKE_CLAUDE_GOAL_ACTIVE_SIGNAL || '',
).trim();
const goalStatusCompletedSignalPath = String(
  process.env.HAPPIER_E2E_FAKE_CLAUDE_GOAL_COMPLETED_SIGNAL || '',
).trim();
const goalStatusSignalsEnabled = goalStatusActiveSignalPath.length > 0 || goalStatusCompletedSignalPath.length > 0;
const goalStatusDefaultObjective = String(
  process.env.HAPPIER_E2E_FAKE_CLAUDE_GOAL_OBJECTIVE || 'fake claude goal objective',
).trim();

// `workflow-activity` scenario (T2): in local/unified-terminal mode, when the workflow signal file
// appears the fake CLI appends a Claude-native Dynamic Workflow transcript stream (`Workflow {script}`
// tool_use + `task_started task_type:"local_workflow"` + `task_progress.workflow_progress[]` carrying
// `workflow_phase`/`workflow_agent` rows + terminal `task_updated`/`task_notification`). These are the
// exact shapes the live workflow ACTIVITY source consumes off the raw transcript channel. The records
// are stamped with the fake CLI's OWN session id so the source's foreign-session guard accepts them.
// The signal file's (non-empty) contents select the preset (`success`, `progress`, `failure`,
// `stopped`, `no-phase`, `long-preview`, `concurrent`); the stream is emitted exactly once.
const workflowSignalPath = String(process.env.HAPPIER_E2E_FAKE_CLAUDE_WORKFLOW_SIGNAL || '').trim();
const workflowSignalsEnabled = workflowSignalPath.length > 0;
const workflowTerminalSignalPath = String(
  process.env.HAPPIER_E2E_FAKE_CLAUDE_WORKFLOW_TERMINAL_SIGNAL || '',
).trim();

function resolveClaudeConfigDir() {
  const explicit = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  if (explicit) return explicit;
  const happierOverride = String(process.env.HAPPIER_CLAUDE_CONFIG_DIR || '').trim();
  if (happierOverride) return happierOverride;
  return path.join(os.homedir(), '.claude');
}

const requireNativeOauth = ['1', 'true', 'yes'].includes(
  String(process.env.HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH || '').trim().toLowerCase(),
);

function parseCredentialsJson(credentialsPath) {
  try {
    const raw = fs.readFileSync(credentialsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return value.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim());
  }
  if (typeof value === 'string') {
    return value
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
  return [];
}

function inspectNativeOauthContract() {
  const claudeConfigDir = resolveClaudeConfigDir();
  const credentialsPath = path.join(claudeConfigDir, '.credentials.json');
  const parsed = parseCredentialsJson(credentialsPath);
  const claudeAiOauth = parsed?.claudeAiOauth && typeof parsed.claudeAiOauth === 'object' ? parsed.claudeAiOauth : null;
  const scopes = normalizeScopes(claudeAiOauth?.scopes);
  const requiredScopes = ['user:inference', 'user:profile', 'user:sessions:claude_code'];
  const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
  const hasOauthEnvToken = typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && process.env.CLAUDE_CODE_OAUTH_TOKEN.length > 0;
  const hasSetupEnvToken = typeof process.env.CLAUDE_CODE_SETUP_TOKEN === 'string' && process.env.CLAUDE_CODE_SETUP_TOKEN.length > 0;
  const hasClaudeConfigDirEnv = typeof process.env.CLAUDE_CONFIG_DIR === 'string' && process.env.CLAUDE_CONFIG_DIR.trim().length > 0;
  const hasHappierClaudeConfigDirEnv =
    typeof process.env.HAPPIER_CLAUDE_CONFIG_DIR === 'string' && process.env.HAPPIER_CLAUDE_CONFIG_DIR.trim().length > 0;
  const hasCredentialFile = fs.existsSync(credentialsPath);
  const hasAccessToken = typeof claudeAiOauth?.accessToken === 'string' && claudeAiOauth.accessToken.length > 0;
  const hasRefreshToken = typeof claudeAiOauth?.refreshToken === 'string' && claudeAiOauth.refreshToken.length > 0;
  const ok =
    hasClaudeConfigDirEnv &&
    hasCredentialFile &&
    hasAccessToken &&
    hasRefreshToken &&
    missingScopes.length === 0 &&
    !hasOauthEnvToken &&
    !hasSetupEnvToken;

  return {
    type: 'native_auth_contract',
    invocationId,
    mode,
    argv: [...argv],
    ts: Date.now(),
    claudeConfigDir,
    credentialsPath,
    hasClaudeConfigDirEnv,
    hasHappierClaudeConfigDirEnv,
    hasCredentialFile,
    hasClaudeAiOauth: !!claudeAiOauth,
    hasAccessToken,
    hasRefreshToken,
    scopes,
    missingScopes,
    hasOauthEnvToken,
    hasSetupEnvToken,
    ok,
  };
}

function readCurrentNativeOauthAccessToken() {
  const claudeConfigDir = resolveClaudeConfigDir();
  const credentialsPath = path.join(claudeConfigDir, '.credentials.json');
  const parsed = parseCredentialsJson(credentialsPath);
  const claudeAiOauth = parsed?.claudeAiOauth && typeof parsed.claudeAiOauth === 'object' ? parsed.claudeAiOauth : null;
  return typeof claudeAiOauth?.accessToken === 'string' ? claudeAiOauth.accessToken : '';
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function shouldFailLocalStdinWhileTokenIsStale() {
  if (scenario !== 'local-auth-fails-while-stale-token') return false;
  return /\bstale\b/i.test(readCurrentNativeOauthAccessToken());
}

function resolveClaudeProjectDirForCwd(cwd) {
  return path.join(resolveClaudeConfigDir(), 'projects', resolveClaudeProjectId(cwd));
}

const transcriptPath = path.join(resolveClaudeProjectDirForCwd(process.cwd()), `${sessionId}.jsonl`);

function safeAppendTranscriptJsonl(obj) {
  try {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.appendFileSync(transcriptPath, `${JSON.stringify(obj)}\n`, 'utf8');
  } catch {
    // Best-effort: a missing transcript will surface as a provider bundle export failure in tests/QA.
  }
}

function createLocalUserTurn(text) {
  return {
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

function createLocalAssistantTurn(text, turn) {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    parent_tool_use_id: null,
    session_id: sessionId,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: {
      id: `fake-local-assistant-${processNonce}-${turn}`,
      type: 'message',
      role: 'assistant',
      model: 'fake-claude',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

function createLocalResultSuccess(turn) {
  return {
    type: 'result',
    subtype: 'success',
    result: `FAKE_CLAUDE_LOCAL_DONE_${turn}`,
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

function appendLocalUserTurn() {
  safeAppendTranscriptJsonl({
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'FAKE_CLAUDE_LOCAL_ACTIVE_TURN' }],
    },
  });
  safeAppendJsonl(logPath, { type: 'local_turn_started', invocationId, ts: Date.now() });
}

function appendLocalAssistantTurnComplete() {
  safeAppendTranscriptJsonl({
    type: 'assistant',
    uuid: randomUUID(),
    parent_tool_use_id: null,
    session_id: sessionId,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: {
      id: `fake-local-assistant-${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'fake-claude',
      content: [{ type: 'text', text: 'FAKE_CLAUDE_LOCAL_DONE' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  safeAppendJsonl(logPath, { type: 'local_turn_completed', invocationId, ts: Date.now() });
}

// A goal signal is only "ready" once the file exists AND carries a non-empty
// objective. This removes a race where the watcher fired on the just-created
// (still empty) file and emitted a goal_status with the fallback condition
// before the test's objective bytes were flushed.
function readReadySignalObjective(signalPath) {
  try {
    const raw = fs.readFileSync(signalPath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Append a Claude-native `goal_status` transcript `attachment` record, matching
 * the real Claude Code shape (and the captured fixtures under
 * `apps/cli/src/backends/claude/workState/__fixtures__/goal-status/`). The
 * record's `sessionId` is the fake CLI's own session id so the launcher's
 * source-session guard accepts it.
 *   - met:false              → goal is active (pursuing `condition`)
 *   - met:true (no sentinel) → goal completed
 *   - met:true + sentinel    → goal cleared/cancelled
 */
function appendGoalStatusAttachment(params) {
  const met = params.met === true;
  const sentinel = params.sentinel === true;
  const condition = String(params.condition || '').trim() || goalStatusDefaultObjective;
  const attachment = {
    type: 'goal_status',
    met,
    condition,
    ...(sentinel ? { sentinel: true } : {}),
    ...(met
      ? { reason: 'fake claude goal completion', iterations: 1, durationMs: 1234, tokens: 42 }
      : {}),
  };
  safeAppendTranscriptJsonl({
    type: 'attachment',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    sessionId,
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd: process.cwd(),
    version: '0.0.0-fake',
    attachment,
  });
  safeAppendJsonl(logPath, {
    type: 'goal_status_attachment_emitted',
    invocationId,
    ts: Date.now(),
    met,
    sentinel,
    condition,
  });
}

/**
 * Append a Claude-native Dynamic Workflow transcript stream for the named preset (T2). Each record
 * is stamped with the fake CLI's own `session_id`/`uuid` so the workflow source's foreign-session
 * guard accepts it, and written to the native transcript file the launcher's scanner tails (the same
 * raw channel that drives the goal source). For `concurrent`, the two runs' records are INTERLEAVED
 * so the per-run tracker is exercised against interleaved progress, never merged.
 */
function appendWorkflowActivityTranscript(preset) {
  const spec = buildWorkflowSpec(preset);
  if (!spec.runs.length) return;

  // Interleave records across runs (round-robin) so concurrent runs arrive intermixed.
  const queues = spec.runs.map((run) => [...run.records]);
  const emitted = [];
  let remaining = queues.reduce((sum, q) => sum + q.length, 0);
  while (remaining > 0) {
    for (const queue of queues) {
      const record = queue.shift();
      if (!record) continue;
      remaining -= 1;
      safeAppendTranscriptJsonl({
        ...record,
        session_id: sessionId,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      });
      emitted.push(record);
    }
  }

  safeAppendJsonl(logPath, {
    type: 'workflow_activity_emitted',
    invocationId,
    ts: Date.now(),
    preset,
    runs: spec.runs.map((run) => ({ toolUseId: run.toolUseId, taskId: run.taskId, title: run.title })),
    recordCount: emitted.length,
  });
}

function appendLocalStdinTurn(promptText, turn) {
  safeAppendTranscriptJsonl(createLocalUserTurn(promptText));
  safeAppendTranscriptJsonl(createLocalAssistantTurn(`FAKE_CLAUDE_LOCAL_OK_${turn}`, turn));
  safeAppendTranscriptJsonl(createLocalResultSuccess(turn));
  safeAppendJsonl(logPath, {
    type: 'local_stdin_turn_completed',
    invocationId,
    ts: Date.now(),
    turn,
    userTextLength: promptText.length,
    userTextSha256: sha256Text(promptText),
    userTextPreview: promptText.slice(0, 800),
  });
}

function shouldSuppressProviderAcceptanceForLocalTurn(turn) {
  return scenario === 'provider-acceptance-timeout-once' && turn === 1;
}

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
  scenario,
  pid: process.pid,
  ts: Date.now(),
  cwd: process.cwd(),
  argv,
  mcpConfigs,
  mergedMcpServers,
});

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('0.0.0-fake\n');
  process.exit(0);
}

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write([
    'Usage: claude [options] [prompt]',
    '  --output-format <format>',
    '  --input-format <format>',
    '  --permission-mode <mode>',
    '',
  ].join('\n'));
  process.exit(0);
}

if (requireNativeOauth) {
  const nativeAuthContract = inspectNativeOauthContract();
  safeAppendJsonl(logPath, nativeAuthContract);
  if (!nativeAuthContract.ok) {
    safeAppendJsonl(logPath, {
      type: 'native_auth_contract_failed',
      invocationId,
      ts: Date.now(),
      missingScopes: nativeAuthContract.missingScopes,
      hasClaudeConfigDirEnv: nativeAuthContract.hasClaudeConfigDirEnv,
      hasHappierClaudeConfigDirEnv: nativeAuthContract.hasHappierClaudeConfigDirEnv,
      hasCredentialFile: nativeAuthContract.hasCredentialFile,
      hasClaudeAiOauth: nativeAuthContract.hasClaudeAiOauth,
      hasAccessToken: nativeAuthContract.hasAccessToken,
      hasRefreshToken: nativeAuthContract.hasRefreshToken,
      hasOauthEnvToken: nativeAuthContract.hasOauthEnvToken,
      hasSetupEnvToken: nativeAuthContract.hasSetupEnvToken,
    });
    process.exit(42);
  }
}

// Ensure the transcript path exists even if this process is terminated before any SDK output is emitted.
safeAppendTranscriptJsonl({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd: process.cwd(),
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
});

const settingsPath = findArgValue(argv, '--settings');
const hookPluginDir = findArgValue(argv, '--plugin-dir');
const hook = parseHookForwarderCommand(settingsPath, hookPluginDir);
function emitHookEvent(hookEventName, payload = {}) {
  return runHookForwarder({
    hook: hook ? { ...hook, hookEventName } : hook,
    payload: {
      ...payload,
      hook_event_name: hookEventName,
      hookEventName,
      session_id: sessionId,
      // Match the real Claude transcript location expected by the CLI handoff export path.
      transcript_path: transcriptPath,
    },
    logPath,
    invocationId,
  });
}

void emitHookEvent('SessionStart', {
    session_id: sessionId,
    // Match the real Claude transcript location expected by the CLI handoff export path.
    transcript_path: transcriptPath,
});

async function runSdkStreamUntilEof() {
  const rl = readline.createInterface({ input: process.stdin });
  let initialized = false;
  let turn = 0;
  let stagedRuntimeActivityTaskId = null;
  let stagedRuntimeActivityTerminalEmitted = false;
  let stagedWorkflowProgressEmitted = false;
  let stagedWorkflowTerminalEmitted = false;

  function emitSdk(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
    safeAppendTranscriptJsonl(obj);
    safeAppendJsonl(logPath, {
      type: 'sdk_stdout',
      invocationId,
      ts: Date.now(),
      messageType: obj?.type ?? null,
      messageSubtype: obj?.subtype ?? null,
    });
  }

  const runtimeActivityTerminalInterval =
    scenario === 'runtime-activity-staged' && runtimeActivityTerminalSignalPath
      ? setInterval(() => {
          if (
            !stagedRuntimeActivityTaskId
            || stagedRuntimeActivityTerminalEmitted
            || !fs.existsSync(runtimeActivityTerminalSignalPath)
          ) return;
          stagedRuntimeActivityTerminalEmitted = true;
          emitSdk({
            type: 'system',
            subtype: 'task_notification',
            task_id: stagedRuntimeActivityTaskId,
            status: 'completed',
            summary: 'staged runtime activity completed',
            uuid: randomUUID(),
            session_id: sessionId,
          });
          safeAppendJsonl(logPath, {
            type: 'runtime_activity_terminal_emitted',
            invocationId,
            taskId: stagedRuntimeActivityTaskId,
            ts: Date.now(),
          });
        }, 50)
      : null;

  const runtimeActivityWorkflowInterval =
    scenario === 'runtime-activity-staged' && workflowSignalsEnabled
      ? setInterval(() => {
          if (!stagedWorkflowProgressEmitted) {
            const preset = readReadySignalObjective(workflowSignalPath);
            if (preset !== null) {
              stagedWorkflowProgressEmitted = true;
              const spec = buildWorkflowSpec(preset);
              for (const run of spec.runs) {
                for (const record of run.records) {
                  emitSdk({
                    ...record,
                    session_id: sessionId,
                    uuid: randomUUID(),
                  });
                }
              }
              safeAppendJsonl(logPath, {
                type: 'runtime_activity_workflow_progress_emitted',
                invocationId,
                preset,
                ts: Date.now(),
              });
            }
          }
          if (
            stagedWorkflowProgressEmitted
            && !stagedWorkflowTerminalEmitted
            && workflowTerminalSignalPath
            && fs.existsSync(workflowTerminalSignalPath)
          ) {
            stagedWorkflowTerminalEmitted = true;
            emitSdk({
              type: 'system',
              subtype: 'task_updated',
              task_id: 'w_progress',
              patch: { status: 'completed', end_time: Date.now() },
              session_id: sessionId,
              uuid: randomUUID(),
            });
            emitSdk({
              type: 'system',
              subtype: 'task_notification',
              task_id: 'w_progress',
              tool_use_id: 'toolu_wf_progress',
              status: 'completed',
              summary: 'research-task completed',
              session_id: sessionId,
              uuid: randomUUID(),
            });
            safeAppendJsonl(logPath, {
              type: 'runtime_activity_workflow_terminal_emitted',
              invocationId,
              ts: Date.now(),
            });
          }
        }, 50)
      : null;

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

  function createCanUseToolControlRequest(toolName, input) {
    return {
      type: 'control_request',
      request_id: `can_use_${randomUUID()}`,
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        input,
      },
    };
  }

  function createSystemInitMessage() {
    const mcpServers = Object.keys(mergedMcpServers || {}).map((name) => ({
      name,
      status: 'connected',
    }));

    const tools = (() => {
      const base = ['Bash(echo)'];
      if (scenario === 'permission-prompt-write') {
        base.push('Write');
      }
      if (scenario === 'transcript-activity-feed') {
        base.push('Diff', 'Edit', 'Bash(echo)');
      }
      return base;
    })();

    return {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'project',
      claude_code_version: '0.0.0-fake',
      cwd: process.cwd(),
      tools,
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
        // Message ids must be unique across *vendor sessions* (separate processes) because the Happier UI
        // can render fork chains that include messages from multiple sessions in a single transcript list.
        // Keep ids stable within a turn so multi-chunk scenarios still update the same logical message.
        id: `fake-assistant-${processNonce}-${turn}`,
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
      userTextLength: typeof promptText === 'string' ? promptText.length : null,
      userTextSha256: typeof promptText === 'string' ? sha256Text(promptText) : null,
      userTextPreview: typeof promptText === 'string' ? promptText.slice(0, 800) : null,
    });
    if (!promptText) continue;

    if (!initialized) {
      initialized = true;
      emitSdk(createSystemInitMessage());
    }

    const now = Date.now();
    turn += 1;

    if (scenario === 'runtime-activity-staged' && stagedRuntimeActivityTaskId === null) {
      stagedRuntimeActivityTaskId = `runtime_activity_${turn}`;
      emitSdk({
        type: 'system',
        subtype: 'task_started',
        task_id: stagedRuntimeActivityTaskId,
        status: 'running',
        description: 'staged runtime activity',
        uuid: randomUUID(),
        session_id: sessionId,
      });
      emitSdk(createAssistantMessage([{ type: 'text', text: `FAKE_CLAUDE_OK_${turn}` }]));
      emitSdk(createResultSuccess());
      continue;
    }

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

    if (scenario === 'permission-prompt-write') {
      const writeToolUseId = `tool_write_${turn}`;
      const filePath = `/tmp/happier-e2e-permission-${turn}.txt`;
      const writeInput = { file_path: filePath, content: `hello from ui e2e ${turn}` };

      const assistant = createAssistantMessage([
        { type: 'text', text: `Attempting to write ${filePath}.` },
        {
          type: 'tool_use',
          id: writeToolUseId,
          name: 'Write',
          input: writeInput,
        },
      ]);

      emitSdk(assistant);
      emitSdk(createCanUseToolControlRequest('Write', writeInput));
      // Intentionally omit the result message: the agent SDK will pause the turn
      // until the client approves/denies the permission and provides a tool_result.
      continue;
    }

    if (scenario === 'transcript-activity-feed') {
      const diffToolUseId = `tool_diff_${turn}`;
      const editToolUseId = `tool_edit_${turn}`;
      const bashToolUseId = `tool_bash_${turn}`;
      const filler = Array.from({ length: 24 }, (_, i) => `• activity ${turn} line ${i + 1}`).join('\n');

      const unifiedDiff = [
        'diff --git a/src/demo.ts b/src/demo.ts',
        '--- a/src/demo.ts',
        '+++ b/src/demo.ts',
        '@@ -1 +1,3 @@',
        '-export function add(a:number,b:number){return a+b}',
        '+export function add(a: number, b: number) {',
        '+  return a + b',
        '+}',
        '',
      ].join('\n');

      emitSdk(
        createAssistantMessage([
          { type: 'text', text: `FAKE_TRANSCRIPT_ACTIVITY_FEED_START_${turn}\n${filler}` },
        ]),
      );

      emitSdk(
        createAssistantMessage([
          {
            type: 'tool_use',
            id: diffToolUseId,
            name: 'Diff',
            input: {
              files: [{ file_path: 'src/demo.ts', unified_diff: unifiedDiff }],
            },
          },
        ]),
      );
      emitSdk(createUserMessage([{ type: 'tool_result', tool_use_id: diffToolUseId, content: 'ok' }]));

      emitSdk(
        createAssistantMessage([
          {
            type: 'tool_use',
            id: editToolUseId,
            name: 'Edit',
            input: {
              file_path: 'src/demo.ts',
              old_string: 'export function add(a:number,b:number){return a+b}',
              new_string: 'export function add(a: number, b: number) {\\n  return a + b\\n}',
            },
          },
        ]),
      );
      emitSdk(createUserMessage([{ type: 'tool_result', tool_use_id: editToolUseId, content: 'ok' }]));

      emitSdk(
        createAssistantMessage([
          {
            type: 'tool_use',
            id: bashToolUseId,
            name: 'Bash',
            input: { command: 'echo hello' },
          },
        ]),
      );
      emitSdk(createUserMessage([{ type: 'tool_result', tool_use_id: bashToolUseId, content: 'hello' }]));

      emitSdk(
        createAssistantMessage([
          { type: 'text', text: `FAKE_TRANSCRIPT_ACTIVITY_FEED_DONE_${turn}\n${filler}` },
        ]),
      );
      emitSdk(createResultSuccess());
      continue;
    }

    if (scenario === 'thinking-markdown-stream') {
      const part1 = [
        '**Considering',
        'Codex',
        'functionalities**',
        '',
        'In',
        'Codex,',
        'I',
        'can',
        'perform',
        '`git',
        'diff`',
        'in',
        'the',
        'terminal.',
        'For',
        'reading,',
        'I',
        'can',
        'use',
        '`ls`',
        'or',
        '`cat`.',
        'For',
        'subagents,',
        "there's",
        'a',
        '`mcp__happier__subagents_delegate_start`',
        'tool',
        '-',
        'we',
        'might',
        'plan',
        'how',
        'to',
        'execute',
        'it.',
      ].join('\n');

      const part2 = [
        '**Exploring',
        'reasoning',
        'options**',
        '',
        'The',
        'user',
        'wants',
        'reasoning,',
        'but',
        'the',
        'system',
        'advises',
        'against',
        'revealing',
        'my',
        'internal',
        'thought',
        'process.',
        'Yet,',
        'they',
        'explicitly',
        'requested',
        'a',
        '"web',
        'fetch".',
      ].join('\n');

      const part3 = [
        '**Considering',
        'commands',
        'and',
        'tools**',
        '',
        'I',
        'think',
        'it',
        'might',
        'be',
        'better',
        'to',
        'use',
        '`curl`',
        'for',
        'the',
        '"web',
        'fetch"',
        'instead',
        'of',
        '`web.run`.',
        '',
        '```sh',
        'curl -I https://example.com',
        '```',
      ].join('\n');

      emitSdk(createAssistantMessage([{ type: 'thinking', thinking: part1 }]));
      emitSdk(createAssistantMessage([{ type: 'thinking', thinking: part2 }]));
      emitSdk(createAssistantMessage([{ type: 'thinking', thinking: part3 }]));
      emitSdk(createAssistantMessage([{ type: 'text', text: `FAKE_CLAUDE_OK_${turn}` }]));
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

    if (scenario === 'diff-tool') {
      const diffToolUseId = `tool_diff_${turn}`;
      const unifiedDiff = [
        'diff --git a/src/demo.ts b/src/demo.ts',
        '--- a/src/demo.ts',
        '+++ b/src/demo.ts',
        '@@ -1 +1,3 @@',
        '-export function add(a:number,b:number){return a+b}',
        '+export function add(a: number, b: number) {',
        '+  return a + b',
        '+}',
        '',
      ].join('\n');

      const assistant = createAssistantMessage([
        {
          type: 'tool_use',
          id: diffToolUseId,
          name: 'Diff',
          input: {
            files: [
              {
                file_path: 'src/demo.ts',
                unified_diff: unifiedDiff,
              },
            ],
          },
        },
      ]);

      const toolResult = createUserMessage([
        { type: 'tool_result', tool_use_id: diffToolUseId, content: 'ok' },
      ]);

      emitSdk(assistant);
      emitSdk(toolResult);
      emitSdk(createResultSuccess());
      continue;
    }

    if (scenario === 'voice-actions-send-session-message') {
      const assistant = createAssistantMessage([
        {
          type: 'text',
          text: [
            'I can send that.',
            '',
            '<voice_actions>',
            JSON.stringify({
              actions: [
                {
                  t: 'sendSessionMessage',
                  args: {
                    message: 'hello from fake voice action',
                  },
                },
              ],
            }),
            '</voice_actions>',
          ].join('\n'),
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

  if (runtimeActivityTerminalInterval) clearInterval(runtimeActivityTerminalInterval);
  if (runtimeActivityWorkflowInterval) clearInterval(runtimeActivityWorkflowInterval);
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
  let localTurnStarted = false;
  let localTurnCompleted = false;
  let localStdinTurn = 0;
  let localComposerBuffer = '';
  let skipNextLfAfterCr = false;
  const renderLocalIdleComposer = () => {
    // Keep the new composer on a distinct terminal row from the submitted prompt. The real Claude
    // TUI renders turn output between them; a single shared newline makes two composer-shaped rows
    // overlap in the screen parser's global matcher and falsely leaves the submitted prompt active.
    process.stdout.write('\n\n❯ ');
    safeAppendJsonl(logPath, {
      type: 'local_idle_composer_rendered',
      invocationId,
      ts: Date.now(),
      turn: localStdinTurn,
    });
  };

  renderLocalIdleComposer();

  function submitLocalComposerBuffer() {
    const promptText = localComposerBuffer.trim();
    localComposerBuffer = '';
    if (!promptText) return;
    localStdinTurn += 1;
    if (shouldFailLocalStdinWhileTokenIsStale()) {
      safeAppendJsonl(logPath, {
        type: 'local_stdin_auth_failed',
        invocationId,
        ts: Date.now(),
        turn: localStdinTurn,
        userTextLength: promptText.length,
        userTextSha256: sha256Text(promptText),
        userTextPreview: promptText.slice(0, 800),
      });
      return;
    }
    if (shouldSuppressProviderAcceptanceForLocalTurn(localStdinTurn)) {
      safeAppendJsonl(logPath, {
        type: 'local_stdin_turn_suppressed',
        reason: 'provider_acceptance_timeout',
        invocationId,
        ts: Date.now(),
        turn: localStdinTurn,
        userTextLength: promptText.length,
        userTextSha256: sha256Text(promptText),
        userTextPreview: promptText.slice(0, 800),
      });
      return;
    }
    void emitHookEvent('UserPromptSubmit');
    appendLocalStdinTurn(promptText, localStdinTurn);
    void emitHookEvent('Stop', { background_tasks: [] });
    renderLocalIdleComposer();
  }

  process.stdin.on('data', (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    for (const char of text) {
      if (skipNextLfAfterCr && char === '\n') {
        skipNextLfAfterCr = false;
        continue;
      }
      skipNextLfAfterCr = false;
      if (char === '\x1b') {
        // Claude's idle composer clears its current draft on Escape. The unified injector uses this
        // bounded behavior to recover only its own verified leftover text.
        localComposerBuffer = '';
        process.stdout.write('\r\x1b[2K❯ ');
        continue;
      }
      if (char === '\r') {
        submitLocalComposerBuffer();
        skipNextLfAfterCr = true;
        continue;
      }
      if (char === '\n') {
        localComposerBuffer += '\n';
        process.stdout.write('\n');
        continue;
      }
      localComposerBuffer += char;
      process.stdout.write(char);
    }
  });
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const maybeStartLocalTurn = () => {
    if (!localActiveTurnEnabled || localTurnStarted) return;
    if (localActiveTurnStartSignalPath && !fs.existsSync(localActiveTurnStartSignalPath)) return;
    localTurnStarted = true;
    appendLocalUserTurn();
  };

  const maybeCompleteLocalTurn = () => {
    if (!localActiveTurnEnabled || !localTurnStarted || localTurnCompleted) return;
    if (!localActiveTurnCompleteSignalPath || !fs.existsSync(localActiveTurnCompleteSignalPath)) return;
    localTurnCompleted = true;
    appendLocalAssistantTurnComplete();
  };

  // T3: emit a `goal_status` attachment when the corresponding signal file
  // appears. Each signal is processed once. `active` reads its objective from the
  // signal file contents (so the test controls the goal text); `completed` reuses
  // the same objective so the work-state item transitions in place.
  let goalActiveEmitted = false;
  let goalCompletedEmitted = false;
  let lastGoalObjective = goalStatusDefaultObjective;
  const maybeEmitGoalStatusSignals = () => {
    if (!goalStatusSignalsEnabled) return;
    if (!goalActiveEmitted && goalStatusActiveSignalPath) {
      const objective = readReadySignalObjective(goalStatusActiveSignalPath);
      if (objective !== null) {
        goalActiveEmitted = true;
        lastGoalObjective = objective;
        appendGoalStatusAttachment({ met: false, condition: lastGoalObjective });
      }
    }
    if (!goalCompletedEmitted && goalStatusCompletedSignalPath) {
      // The completed signal reuses the active objective unless it carries its
      // own; gate on the active goal having been emitted so the transition is
      // strictly active → complete in transcript order.
      const objective = readReadySignalObjective(goalStatusCompletedSignalPath);
      if (objective !== null && goalActiveEmitted) {
        goalCompletedEmitted = true;
        appendGoalStatusAttachment({ met: true, condition: objective || lastGoalObjective });
      }
    }
  };

  // T2: emit the Dynamic Workflow transcript stream once the workflow signal file appears AND
  // carries a non-empty preset name. Gating on non-empty contents removes the same create-before-
  // flush race the goal signal documents: the watcher could otherwise fire on the just-created
  // (still empty) signal file and emit the env-default preset before the test's chosen preset bytes
  // were flushed. The signal is processed once.
  let workflowEmitted = false;
  const maybeEmitWorkflowActivity = () => {
    if (!workflowSignalsEnabled || workflowEmitted) return;
    // `readReadySignalObjective` returns null for a missing OR empty file, so the preset is read only
    // once the test's chosen preset bytes are flushed — never the create-before-flush empty state.
    const preset = readReadySignalObjective(workflowSignalPath);
    if (preset === null) return;
    workflowEmitted = true;
    appendWorkflowActivityTranscript(preset);
  };

  maybeStartLocalTurn();
  maybeEmitGoalStatusSignals();
  maybeEmitWorkflowActivity();
  const localTurnInterval = localActiveTurnEnabled || goalStatusSignalsEnabled || workflowSignalsEnabled
    ? setInterval(() => {
        maybeStartLocalTurn();
        maybeCompleteLocalTurn();
        maybeEmitGoalStatusSignals();
        maybeEmitWorkflowActivity();
      }, 100)
    : null;
  const interval = setInterval(() => {}, 1000);
  const stop = () => {
    if (localTurnInterval) clearInterval(localTurnInterval);
    clearInterval(interval);
    safeAppendJsonl(logPath, { type: 'local_exited', invocationId, ts: Date.now(), stdinTurns: localStdinTurn });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
