import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.js';
import { createFakeControlPort } from './tuiControls/fakeControlPort.js';
import { CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID } from './tuiControls/index.js';

const IDLE = ['╭─────╮', '│ >   │', '╰─────╯', '  ? for shortcuts'].join('\n');
const EFFORT_OK = ['Set reasoning effort to high', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
const GENERATING = ['● working', '✶ Forging… (10s · esc to interrupt)', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
const GEN_ACCEPT = [
  '● working',
  '✶ Forging… (12s · esc to interrupt)',
  '╭─────╮', '│ >   │', '╰─────╯',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

const FAST_TIMINGS = {
  slashPickerSettleMs: 1,
  commandSettleMs: 1,
  modeCycleSettleMs: 1,
  verifyPollIntervalMs: 1,
  verifyPollTimeoutMs: 5,
} as const;

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-tuicontrol-'));
  tempRoots.push(dir);
  return dir;
}

function buildRuntime(params: Readonly<{
  featureEnabled: boolean;
  controlPortCaptures?: readonly string[] | null;
  configDir: string;
  sessionSend?: ReturnType<typeof vi.fn>;
  sessionWriteAgentState?: ReturnType<typeof vi.fn>;
}>) {
  const terminalHost = createTerminalHostFixture();
  const fakePort = params.controlPortCaptures
    ? createFakeControlPort({ captures: params.controlPortCaptures })
    : null;
  (terminalHost.service.controlPort as ReturnType<typeof vi.fn>).mockResolvedValue(fakePort);
  const events = createEventsFixture();
  const ctx = createPluginContextFixture(terminalHost.service, events.service, {
    enabledFeatures: [
      'providers.claude.unifiedTerminal',
      ...(params.featureEnabled ? [CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID] : []),
    ],
    ...(params.sessionSend ? { sessionSend: params.sessionSend } : {}),
    ...(params.sessionWriteAgentState ? { sessionWriteAgentState: params.sessionWriteAgentState } : {}),
  });
  const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
    ctx,
    directory: '/tmp/claude-project',
    happierSessionId: 'happy-session-1',
    hostPreference: 'zellij',
    launchEnv: { CLAUDE_CONFIG_DIR: params.configDir },
    permissionMode: 'default',
    tuiControl: { timings: FAST_TIMINGS },
  }));
  return { envelope, runtime: envelope.operations, fakePort, terminalHost };
}

describe('Claude Unified TUI runtime control integration (updateSessionRuntimeConfig)', () => {
  it('keeps the legacy requires_interactive_control outcome when the feature is OFF', async () => {
    const configDir = await makeConfigDir();
    const { runtime, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [IDLE, IDLE, EFFORT_OK],
      configDir,
    });
    try {
      await runtime.startOrLoadSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'high' },
      });
      expect(outcome).toMatchObject({ status: 'requires_interactive_control' });
      expect(terminalHost.service.controlPort).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies a post-launch effort override through the verified TUI control when the feature is ON', async () => {
    const configDir = await makeConfigDir();
    const sessionSend = vi.fn(async () => ({ ok: true }));
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE, IDLE, EFFORT_OK],
      configDir,
      sessionSend,
    });
    try {
      await runtime.startOrLoadSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'high' },
      });
      expect(outcome).toMatchObject({ status: 'applied' });
      expect(fakePort?.sentLiteral).toContain('/effort high');
      // Outcome events ride the runtime-config-outcome session-event contract.
      expect(sessionSend).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'sessionEvent',
        event: expect.objectContaining({
          type: 'runtime-config-outcome',
          runtime: 'claude-unified-terminal',
          status: 'applied',
          changes: [expect.objectContaining({ key: 'reasoningEffort', effective: 'high' })],
        }),
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('falls back to the legacy outcome when the host adapter exposes no control port', async () => {
    const configDir = await makeConfigDir();
    const { runtime } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: null,
      configDir,
    });
    try {
      await runtime.startOrLoadSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'high' },
      });
      expect(outcome).toMatchObject({ status: 'requires_interactive_control' });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps the legacy outcome for directives the controller cannot own (fallback model)', async () => {
    const configDir = await makeConfigDir();
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE],
      configDir,
    });
    try {
      await runtime.startOrLoadSession();
      const outcome = await runtime.updateSessionRuntimeConfig({ fallbackModel: 'claude-haiku-4-5' });
      expect(outcome).toMatchObject({ status: 'requires_interactive_control' });
      expect(fakePort?.sentLiteral).toHaveLength(0);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});

describe('Claude Unified static inFlightConfigApplySupported capability (lane Q)', () => {
  function captureAgentState() {
    let state: Readonly<Record<string, unknown>> = {};
    const writeAgentState = vi.fn(async (request: { kind: string; handler?: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> }) => {
      if (request.kind === 'update' && request.handler) state = request.handler(state);
    });
    return { writeAgentState, capabilities: () => (state.capabilities ?? {}) as Readonly<Record<string, unknown>> };
  }

  it('publishes the capability into agentState when the feature is ON so the UI gate can open', async () => {
    const configDir = await makeConfigDir();
    const captured = captureAgentState();
    const { runtime } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE],
      configDir,
      sessionWriteAgentState: captured.writeAgentState,
    });
    try {
      expect(captured.capabilities().inFlightConfigApplySupported).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('never publishes the capability when the feature is OFF (fail-closed UI gate)', async () => {
    const configDir = await makeConfigDir();
    const captured = captureAgentState();
    const { runtime } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [IDLE],
      configDir,
      sessionWriteAgentState: captured.writeAgentState,
    });
    try {
      expect('inFlightConfigApplySupported' in captured.capabilities()).toBe(false);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});

describe('Claude Unified in-flight mode delta seam (applyConfigDeltaInFlight)', () => {
  it('applies a permission-mode delta mid-generation via verified ShiftTab when the feature is ON', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [GENERATING, GEN_ACCEPT],
      configDir,
    });
    try {
      await runtime.startOrLoadSession();
      const nativeRuntime = envelope.nativeRuntime as {
        applyConfigDeltaInFlight?: (delta: { permissionMode: string }) => Promise<{ status: string }>;
      };
      expect(typeof nativeRuntime.applyConfigDeltaInFlight).toBe('function');
      const result = await nativeRuntime.applyConfigDeltaInFlight!({ permissionMode: 'acceptEdits' });
      expect(result).toMatchObject({ status: 'applied' });
      expect(fakePort?.sentKeys).toEqual(['ShiftTab']);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reports unsupported when the feature is OFF so the message keeps the queue path', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [GENERATING, GEN_ACCEPT],
      configDir,
    });
    try {
      await runtime.startOrLoadSession();
      const nativeRuntime = envelope.nativeRuntime as {
        applyConfigDeltaInFlight?: (delta: { permissionMode: string }) => Promise<{ status: string }>;
      };
      const result = await nativeRuntime.applyConfigDeltaInFlight!({ permissionMode: 'acceptEdits' });
      expect(result).toMatchObject({ status: 'unsupported' });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});
