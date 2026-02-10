#!/usr/bin/env node
/**
 * Deterministic ACP stub provider for Happier E2E tests.
 *
 * Goal: exercise "in-flight steer" behavior without any real vendor credentials.
 *
 * Behavior:
 * - First prompt starts a long-running turn and emits an early marker:
 *   `ACP_STUB_RUNNING primary=<primary>`
 * - A second prompt received while the first is still running is treated as a "steer" input.
 * - Once the steer input is received, the first prompt completes and emits:
 *   `ACP_STUB_DONE primary=<primary> steer=<steer>`
 *
 * Note: the E2E harness gates step2 ("steer") on observing the RUNNING marker while the first
 * turn is still in flight. The CLI can optionally record these markers into tool-trace via
 * `HAPPIER_E2E_ACP_TRACE_MARKERS=1`, but the stub itself only emits plain agent message chunks.
 */

import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadAcpSdk() {
  const fromEnv = typeof process.env.HAPPIER_E2E_ACP_SDK_ENTRY === 'string'
    ? process.env.HAPPIER_E2E_ACP_SDK_ENTRY.trim()
    : '';

  // Default to the CLI workspace dependency (monorepo installs can be non-hoisted).
  const repoRoot = resolve(__dirname, '../../../..');
  const defaultEntry = join(repoRoot, 'apps', 'cli', 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js');

  const candidates = [fromEnv, defaultEntry].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      return await import(pathToFileURL(candidate).href);
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `Unable to load ACP SDK. Set HAPPIER_E2E_ACP_SDK_ENTRY or ensure ${defaultEntry} exists.`,
  );
}

const acp = await loadAcpSdk();

function parseTaggedValue(text, tag) {
  if (typeof text !== 'string' || !text) return null;
  const idx = text.indexOf(tag);
  if (idx < 0) return null;
  const rest = text.slice(idx + tag.length);
  const m = rest.match(/^([^\s\r\n]+)/);
  return m ? m[1] : null;
}

function extractPromptText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function withTimeout(promise, timeoutMs, label) {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (t) clearTimeout(t);
  });
}

function resolveSteerWaitMs() {
  const raw = typeof process.env.HAPPIER_E2E_ACP_STUB_STEER_WAIT_MS === 'string'
    ? process.env.HAPPIER_E2E_ACP_STUB_STEER_WAIT_MS.trim()
    : '';
  if (!raw) return 45_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return 45_000;
  return Math.min(parsed, 10 * 60_000);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class AcpStubAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  async authenticate(_params) {
    return {};
  }

  async newSession(_params) {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      inFlight: false,
      primary: null,
      steer: null,
      steerDeferred: null,
      canceled: false,
    });
    return { sessionId };
  }

  async loadSession(params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        inFlight: false,
        primary: null,
        steer: null,
        steerDeferred: null,
        canceled: false,
      });
    }
    return {};
  }

  async cancel(params) {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.canceled = true;
    if (state.steerDeferred) {
      try {
        state.steerDeferred.reject(new Error('canceled'));
      } catch {
        // ignore
      }
    }
  }

  async prompt(params) {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Missing sessionId');
    }

    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error('Unknown sessionId');
    }

    const rawText = extractPromptText(params.prompt);
    const primaryTag = 'ACP_STUB_PRIMARY=';
    const steerTag = 'ACP_STUB_STEER=';
    const usageUpdateTag = 'ACP_STUB_USAGE_UPDATE=';
    const maybePrimary = parseTaggedValue(rawText, primaryTag);
    const maybeSteer = parseTaggedValue(rawText, steerTag);
    const maybeUsage = parseTaggedValue(rawText, usageUpdateTag);

    if (maybeUsage) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `ACP_STUB_USAGE_UPDATE_DONE ${maybeUsage}` },
        },
      });

      // Emit deterministic usage so the CLI forwards a token_count message.
      return {
        stopReason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
      };
    }

    if (!state.inFlight) {
      // Primary prompt: start a "long-running" turn.
      const primary = maybePrimary ?? `primary_${randomUUID()}`;
      state.inFlight = true;
      state.primary = primary;
      state.steer = null;
      state.canceled = false;
      state.steerDeferred = createDeferred();

      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `ACP_STUB_RUNNING primary=${primary}` },
        },
      });

      let steer = null;
      try {
        // The harness step2 enqueue is gated on trace-marker observation, which can be delayed
        // by buffering or test load. Keep this timeout comfortably below provider inactivity caps.
        steer = await withTimeout(state.steerDeferred.promise, resolveSteerWaitMs(), 'waiting for steer');
      } catch (error) {
        // Surface a deterministic failure marker; the harness will time out anyway if the CLI gets stuck.
        const message = error instanceof Error ? error.message : String(error);
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `ACP_STUB_ERROR ${message}` },
          },
        });
        throw error;
      } finally {
        state.steerDeferred = null;
      }

      const steerValue = typeof steer === 'string' ? steer : String(steer ?? '');
      const doneMarker = `ACP_STUB_DONE primary=${primary} steer=${steerValue}`;

      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: doneMarker },
        },
      });

      state.inFlight = false;
      state.primary = null;
      state.steer = null;
      state.canceled = false;

      return { stopReason: 'end_turn' };
    }

    // In-flight prompt: treat as steer input. (Should be called by client via in-flight steer.)
    const trimmed = rawText.trim();
    const steer = maybeSteer ?? maybePrimary ?? (trimmed ? trimmed : `steer_${randomUUID()}`);
    state.steer = steer;
    if (state.steerDeferred) {
      try {
        state.steerDeferred.resolve(steer);
      } catch {
        // ignore
      }
    }

    // Ack marker helps step satisfaction in case timing is tight.
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `ACP_STUB_STEER_RECEIVED steer=${steer}` },
      },
    });

    return { stopReason: 'end_turn' };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

// Constructing AgentSideConnection starts the request loop.
// eslint-disable-next-line no-new
new acp.AgentSideConnection((conn) => new AcpStubAgent(conn), stream);
