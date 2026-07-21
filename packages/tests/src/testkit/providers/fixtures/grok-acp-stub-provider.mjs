#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const decoder = new TextDecoder();
let buffer = '';
let pendingPrompt = null;
let nextSession = 1;
const sessions = new Set();
const sessionModels = new Map();
let initialized = false;
let authenticated = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function recordPath() {
  const configured = process.env.HAPPIER_GROK_STUB_RECORD_PATH?.trim();
  if (configured) return configured;
  const home = process.env.HAPPIER_HOME_DIR || process.env.HOME || process.cwd();
  return join(home, 'grok-acp-stub', 'requests.jsonl');
}

function sanitize(value, key = '') {
  if (/key|token|secret|authorization/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== 'object') return value;
  const namedSecret = typeof value.name === 'string'
    && /key|token|secret|authorization/i.test(value.name);
  const out = Object.create(null);
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = namedSecret && childKey === 'value'
      ? '[REDACTED]'
      : sanitize(childValue, childKey);
  }
  return out;
}

function record(message) {
  const path = recordPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(sanitize(message))}\n`, 'utf8');
}

const startupArgv = process.argv.slice(2);
record({ kind: 'startup', argv: startupArgv });
if (JSON.stringify(startupArgv) !== JSON.stringify(['--no-auto-update', 'agent', 'stdio'])) {
  process.stderr.write('grok stub: expected exact --no-auto-update agent stdio argv\n');
  process.exit(64);
}

function fail(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32001, message } });
}

function requireInitialized(id) {
  if (initialized) return true;
  fail(id, 'grok stub: initialize must complete before session operations');
  return false;
}

function requireAuthenticated(id) {
  if (!requireInitialized(id)) return false;
  if (authenticated) return true;
  fail(id, 'grok stub: authenticate must complete before session operations');
  return false;
}

function requireSession(id, sessionId) {
  if (!requireAuthenticated(id)) return false;
  if (typeof sessionId === 'string' && sessions.has(sessionId)) return true;
  fail(id, 'grok stub: operation requires a created or loaded session');
  return false;
}

function promptText(prompt) {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => typeof block.text === 'string' ? block.text : '')
    .join('\n');
}

function emitText(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  });
}

const reasoningEffortMeta = (reasoningEffort, reasoningEfforts) => ({
  supportsReasoningEffort: true,
  reasoningEffort,
  reasoningEfforts,
});
const effortOptions = (values) => values.map((value) => ({
  id: value,
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

const advertisedModels = [
  {
    id: 'grok-4.1-fast',
    name: 'Grok 4.1 Fast',
    meta: reasoningEffortMeta('medium', effortOptions(['medium', 'high'])),
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    meta: reasoningEffortMeta('medium', effortOptions(['low', 'medium', 'high'])),
  },
  {
    id: 'grok-switch-fails',
    name: 'Grok switch failure fixture',
    meta: reasoningEffortMeta('high', effortOptions(['high'])),
  },
];

function sessionResult(sessionId, fallback = false) {
  const currentModelId = fallback ? 'grok-build' : (sessionModels.get(sessionId) ?? 'grok-4.5');
  return {
    sessionId,
    modes: {
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
    },
    models: {
      currentModelId,
      availableModels: fallback
        ? [{ id: 'grok-build', name: 'Grok Build' }]
        : advertisedModels,
    },
  };
}

function startQuestion(id, sessionId, wrapped, questionKind = 'options') {
  const extensionRequestId = wrapped
    ? 'grok-stub-question-wrapped'
    : `grok-stub-question-${questionKind}`;
  pendingPrompt = { id, sessionId, kind: 'question', wrapped, questionKind, extensionRequestId };
  const method = wrapped ? '_x.ai/ask_user_question' : 'x.ai/ask_user_question';
  const questions = questionKind === 'freeform'
    ? [{ id: 'details', question: 'Describe the change', options: [] }]
    : questionKind === 'mixed'
      ? [{
          id: 'locations',
          question: 'Where?',
          multiSelect: true,
          options: [
            { id: 'dc', label: 'Washington, D.C.' },
            { id: 'remote', label: 'Remote' },
          ],
        }]
      : [
          {
            id: 'location',
            question: 'Where should this run?',
            multiSelect: true,
            options: [
              { id: 'dc', label: 'Washington, D.C.', description: 'Comma-bearing option' },
              { id: 'reserved', label: '__proto__', preview: 'Reserved-key label' },
              { id: 'remote', label: 'Remote' },
            ],
          },
        ];
  const params = {
    sessionId,
    toolCallId: extensionRequestId,
    mode: 'default',
    questions,
  };
  send({
    jsonrpc: '2.0',
    id: extensionRequestId,
    method,
    params: wrapped ? { method: 'x.ai/ask_user_question', params } : params,
  });
}

function handleResponse(message) {
  if (pendingPrompt?.kind !== 'question' || message.id !== pendingPrompt.extensionRequestId) return;
  const { id, sessionId, wrapped, questionKind } = pendingPrompt;
  pendingPrompt = null;
  const result = message.result;
  const answers = result && typeof result === 'object' ? result.answers : null;
  const expectedQuestion = questionKind === 'freeform'
    ? 'Describe the change'
    : questionKind === 'mixed'
      ? 'Where?'
      : 'Where should this run?';
  const selected = answers && typeof answers === 'object'
    && Object.prototype.hasOwnProperty.call(answers, expectedQuestion)
    ? answers[expectedQuestion]
    : null;
  const notes = result?.annotations?.[expectedQuestion]?.notes;
  const exactAnswer = questionKind === 'freeform'
    ? Array.isArray(selected)
      && selected.length === 1
      && selected[0] === 'Other'
      && notes === 'Keep commas, exactly\nand preserve the newline'
    : questionKind === 'mixed'
      ? Array.isArray(selected)
        && selected.length === 2
        && selected[0] === 'Washington, D.C.'
        && selected[1] === 'Other'
        && notes === 'A custom, multiline\nlocation'
      : Array.isArray(selected)
        && selected.length === 2
        && selected[0] === 'Washington, D.C.'
        && selected[1] === '__proto__';
  if (result?.outcome !== 'accepted'
    || !answers
    || typeof answers !== 'object'
    || Array.isArray(answers)
    || Object.keys(answers).length !== 1
    || !exactAnswer) {
    fail(id, 'grok stub: question response must preserve the exact accepted answer arrays');
    return;
  }
  emitText(
    sessionId,
    `${wrapped ? 'GROK_STUB_QUESTION_RESULT_WRAPPED' : 'GROK_STUB_QUESTION_RESULT'} ${JSON.stringify(sanitize(result))}`,
  );
  ok(id, { stopReason: 'end_turn' });
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (typeof method !== 'string') return;

  if (method === 'initialize' && id != null) {
    initialized = true;
    ok(id, {
      protocolVersion: 1,
      authMethods: [
        { id: 'xai.api_key', name: 'xAI API key' },
        { id: 'grok.com', name: 'Grok login' },
      ],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      _meta: { defaultAuthMethodId: 'xai.api_key' },
    });
    return;
  }

  if (method === 'authenticate' && id != null) {
    if (!requireInitialized(id)) return;
    const methodId = typeof params?.methodId === 'string' ? params.methodId : '';
    const headless = params?._meta?.headless === true;
    if (methodId !== 'xai.api_key' || !headless) {
      send({ jsonrpc: '2.0', id, error: { code: -32001, message: 'fixture auth contract mismatch' } });
      return;
    }
    authenticated = true;
    ok(id, {});
    return;
  }

  if (method === 'session/new' && id != null) {
    if (!requireAuthenticated(id)) return;
    const sessionId = `grok-stub-session-${nextSession++}`;
    sessions.add(sessionId);
    sessionModels.set(sessionId, 'grok-4.5');
    ok(id, sessionResult(sessionId));
    return;
  }

  if (method === 'session/load' && id != null) {
    if (!requireAuthenticated(id)) return;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    if (!sessionId) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'sessionId required' } });
      return;
    }
    sessions.add(sessionId);
    sessionModels.set(sessionId, sessionId === 'grok-fallback-session' ? 'grok-build' : 'grok-4.5');
    ok(id, sessionResult(sessionId, sessionId === 'grok-fallback-session'));
    return;
  }

  if (method === 'session/prompt' && id != null) {
    if (!requireAuthenticated(id)) return;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    if (!sessions.has(sessionId)) {
      fail(id, 'grok stub: prompt session must be created or loaded first');
      return;
    }
    const text = promptText(params?.prompt);
    if (text.includes('GROK_STUB_STRUCTURED_QUESTION_WRAPPED')) {
      startQuestion(id, sessionId, true);
      return;
    }
    if (text.includes('GROK_STUB_FREEFORM_QUESTION')) {
      startQuestion(id, sessionId, false, 'freeform');
      return;
    }
    if (text.includes('GROK_STUB_MIXED_FREEFORM_QUESTION')) {
      startQuestion(id, sessionId, false, 'mixed');
      return;
    }
    if (text.includes('GROK_STUB_STRUCTURED_QUESTION')) {
      startQuestion(id, sessionId, false);
      return;
    }
    if (text.includes('GROK_STUB_CANCEL')) {
      pendingPrompt = { id, sessionId, kind: 'cancel' };
      emitText(sessionId, 'GROK_STUB_CANCEL_PENDING');
      return;
    }
    emitText(sessionId, `GROK_STUB_READY ${text} session=${sessionId}`);
    ok(id, { stopReason: 'end_turn' });
    return;
  }

  if (method === 'session/cancel') {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    if (pendingPrompt && pendingPrompt.sessionId === sessionId) {
      const pending = pendingPrompt;
      pendingPrompt = null;
      ok(pending.id, { stopReason: 'cancelled' });
    }
    if (id != null) ok(id, {});
    return;
  }

  if (method === 'session/set_model' && id != null) {
    if (!requireSession(id, params?.sessionId)) return;
    const model = advertisedModels.find((candidate) => candidate.id === params?.modelId);
    if (!model) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown fixture model' } });
      return;
    }
    const effort = params?._meta?.reasoningEffort;
    const allowedEfforts = model.meta.reasoningEfforts;
    if (effort !== undefined && !allowedEfforts.some((option) => option.value === effort)) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'fixture reasoning effort mismatch' } });
      return;
    }
    if (params.modelId === 'grok-switch-fails') {
      send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'fixture switch failed' } });
      return;
    }
    sessionModels.set(params.sessionId, params.modelId);
    ok(id, {});
    return;
  }

  if (method === 'session/set_mode' && id != null) {
    if (!requireSession(id, params?.sessionId)) return;
    if (params?.modeId !== 'default' && params?.modeId !== 'plan') {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown fixture mode' } });
      return;
    }
    ok(id, {});
    return;
  }

  if (id != null) ok(id, {});
}

process.stdin.on('data', (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!message || typeof message !== 'object') continue;
    record(message);
    if (!('method' in message) && 'id' in message) handleResponse(message);
    else handleRequest(message);
  }
});
