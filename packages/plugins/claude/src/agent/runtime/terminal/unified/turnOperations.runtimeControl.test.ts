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
import { createClaudeLegacyActiveInputStatusPublisher } from './bindSession.testkit.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.testkit.js';
import { createFakeControlPort } from './tuiControls/fakeControlPort.js';
import { CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID } from './tuiControls/index.js';

const IDLE = ['╭─────╮', '│ >   │', '╰─────╯', '  ? for shortcuts'].join('\n');
const USER_DRAFT = ['╭─────╮', '│ > do not send this yet │', '╰─────╯'].join('\n');
const ACCEPT_EDITS_IDLE = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
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

function captureAgentState() {
  let state: Readonly<Record<string, unknown>> = {};
  const writeAgentState = vi.fn(async (request: {
    kind: string;
    handler?: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  }) => {
    if (request.kind === 'update' && request.handler) state = request.handler(state);
  });
  return {
    writeAgentState,
    capabilities: () => (state.capabilities ?? {}) as Readonly<Record<string, unknown>>,
  };
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
      'agents.claude.unifiedTerminal',
      ...(params.featureEnabled ? [CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID] : []),
    ],
    ...(params.sessionSend ? { sessionSend: params.sessionSend } : {}),
    ...(params.sessionWriteAgentState ? { sessionWriteAgentState: params.sessionWriteAgentState } : {}),
  });
  const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
    ctx,
    activeInput: createClaudeLegacyActiveInputStatusPublisher(ctx),
    directory: '/tmp/claude-project',
    happierSessionId: 'happy-session-1',
    hostPreference: 'zellij',
    launchEnv: { CLAUDE_CONFIG_DIR: params.configDir },
    permissionMode: 'default',
    tuiControl: { timings: FAST_TIMINGS },
  }));
  return { envelope, runtime: envelope.operations, fakePort, terminalHost };
}

type ComposerClearNativeRuntime = Readonly<{
  clearTerminalComposer?: (request?: Readonly<{
    sessionId?: string;
    expectedStateAtMs?: number;
  }>) => Promise<Readonly<{
    ok: boolean;
    status: string;
    sessionId?: string;
    error?: string;
  }>>;
}>;

describe('Claude Unified TUI runtime control integration (updateSessionRuntimeConfig)', () => {
  it('keeps the legacy requires_interactive_control outcome when the feature is OFF', async () => {
    const configDir = await makeConfigDir();
    const { runtime, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [IDLE, IDLE, EFFORT_OK],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'high' },
      });
      expect(outcome).toMatchObject({ status: 'requires_interactive_control' });
      expect(terminalHost.service.controlPort).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reports permission-mode runtime updates as requiring restart when the feature is OFF', async () => {
    const configDir = await makeConfigDir();
    const { runtime, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [IDLE, ACCEPT_EDITS_IDLE],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        permissionMode: 'acceptEdits',
      });

      expect(outcome).toMatchObject({
        status: 'requires_restart',
        reason: 'tui_runtime_control_unavailable',
      });
      expect(terminalHost.service.controlPort).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('blocks the next canonical pending prompt when runtime config cannot apply before delivery', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [IDLE, ACCEPT_EDITS_IDLE],
      configDir,
    });
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      deliveryBlockedReason?: string;
    }> = [];
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
    try {
      await runtime.startProviderSession();
      await runtime.updateSessionRuntimeConfig({ permissionMode: 'acceptEdits' });

      await runtime.sendTurnPrompt('prompt requiring acceptEdits', {
        localId: 'local-runtime-config-blocked',
        localIds: ['local-runtime-config-blocked'],
        userMessageSeq: null,
      });

      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      expect(rejected).toEqual([{
        localIds: ['local-runtime-config-blocked'],
        userMessageSeq: null,
        deliveryBlockedReason: 'runtime_config_blocked',
      }]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not block prompt delivery when ambient runtime config cannot apply before delivery', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [IDLE],
      configDir,
    });
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      deliveryBlockedReason?: string;
    }> = [];
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
    try {
      await runtime.startProviderSession();
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-sonnet-4-6' });

      await runtime.sendTurnPrompt('prompt must not wait for ambient model config', {
        localId: 'local-ambient-runtime-config',
        localIds: ['local-ambient-runtime-config'],
        userMessageSeq: null,
      });

      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      expect(rejected).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps active-turn runtime-config user-draft blockers transient', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [IDLE, ACCEPT_EDITS_IDLE],
      configDir,
    });
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      deliveryBlockedReason?: string;
    }> = [];
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
    try {
      await runtime.startProviderSession();
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      await runtime.updateSessionRuntimeConfig({ permissionMode: 'acceptEdits' });
      await runtime.sendTurnPrompt('prompt requiring acceptEdits after turn end', {
        localId: 'local-active-runtime-config-blocked',
        localIds: ['local-active-runtime-config-blocked'],
        userMessageSeq: null,
      });

      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      expect(rejected).toEqual([]);
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
      await runtime.startProviderSession();
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

  it('applies a metadata-only permission-mode override through verified TUI mode cycling', async () => {
    const configDir = await makeConfigDir();
    const sessionSend = vi.fn(async () => ({ ok: true }));
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE, ACCEPT_EDITS_IDLE],
      configDir,
      sessionSend,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        permissionMode: 'acceptEdits',
      });

      expect(outcome).toMatchObject({ status: 'applied' });
      expect(fakePort?.sentKeys).toEqual(['ShiftTab']);
      expect(fakePort?.sentLiteral.some((text) => text.startsWith('/permissions'))).toBe(false);
      expect(sessionSend).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'sessionEvent',
        event: expect.objectContaining({
          type: 'runtime-config-outcome',
          runtime: 'claude-unified-terminal',
          status: 'applied',
          changes: [expect.objectContaining({ key: 'permissionMode', effective: 'acceptEdits' })],
        }),
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies a metadata-only mode-only permission change during generation through the mode-cycle window', async () => {
    const configDir = await makeConfigDir();
    const sessionSend = vi.fn(async () => ({ ok: true }));
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [GENERATING, GEN_ACCEPT],
      configDir,
      sessionSend,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        permissionMode: 'acceptEdits',
      });

      expect(outcome).toMatchObject({ status: 'applied' });
      expect(fakePort?.sentKeys).toEqual(['ShiftTab']);
      expect(sessionSend).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'sessionEvent',
        event: expect.objectContaining({
          type: 'runtime-config-outcome',
          runtime: 'claude-unified-terminal',
          status: 'applied',
          changes: [expect.objectContaining({ key: 'permissionMode', effective: 'acceptEdits' })],
        }),
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reports launch-only permission modes as requiring restart through runtime-control outcomes', async () => {
    const configDir = await makeConfigDir();
    const { runtime } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        permissionMode: 'read-only',
      });

      expect(outcome).toMatchObject({
        status: 'requires_restart',
        reason: 'mode_not_cycle_reachable:read-only',
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not apply the retired plural configOptions alias through TUI controls', async () => {
    const configDir = await makeConfigDir();
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE, IDLE, EFFORT_OK],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        configOptions: { reasoning_effort: 'high' },
      });

      expect(outcome).toMatchObject({
        status: 'requires_interactive_control',
        reason: 'unknown_directive:configOptions',
      });
      expect(fakePort?.sentLiteral).not.toContain('/effort high');
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
      await runtime.startProviderSession();
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
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({ fallbackModel: 'claude-haiku-4-5' });
      expect(outcome).toMatchObject({ status: 'requires_interactive_control' });
      expect(fakePort?.sentLiteral).toHaveLength(0);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});

describe('Claude Unified terminal composer clear runtime control', () => {
  it('exposes a user-authorized clear control that clears a safe draft with Escape', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [USER_DRAFT, IDLE],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const nativeRuntime = envelope.nativeRuntime as ComposerClearNativeRuntime;

      const result = await nativeRuntime.clearTerminalComposer?.({ sessionId: 'happy-session-1' });

      expect(result).toMatchObject({ ok: true, status: 'cleared', sessionId: 'happy-session-1' });
      expect(fakePort?.sentKeys).toEqual(['Escape']);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('returns unsupported without touching the terminal when TUI runtime control is disabled', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [USER_DRAFT, IDLE],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const nativeRuntime = envelope.nativeRuntime as ComposerClearNativeRuntime;

      const result = await nativeRuntime.clearTerminalComposer?.({ sessionId: 'happy-session-1' });

      expect(result).toMatchObject({ ok: false, status: 'unsupported' });
      expect(terminalHost.service.controlPort).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('rejects a composer clear when the caller observed an older active-input state', async () => {
    const configDir = await makeConfigDir();
    const captured = captureAgentState();
    const { envelope, runtime, terminalHost } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [USER_DRAFT, IDLE],
      configDir,
      sessionWriteAgentState: captured.writeAgentState,
    });
    try {
      await runtime.startProviderSession();
      const publishedStateAt = captured.capabilities().inFlightSteerStateAt;
      expect(typeof publishedStateAt).toBe('number');

      const nativeRuntime = envelope.nativeRuntime as ComposerClearNativeRuntime;
      const result = await nativeRuntime.clearTerminalComposer?.({
        sessionId: 'happy-session-1',
        expectedStateAtMs: (publishedStateAt as number) - 1,
      });

      expect(result).toEqual({
        ok: false,
        status: 'stale_state',
        sessionId: 'happy-session-1',
        error: 'stale_terminal_input_state',
      });
      expect(terminalHost.service.controlPort).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('wakes a prompt that was deferred behind the terminal user draft after clear succeeds', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, terminalHost } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [USER_DRAFT, IDLE],
      configDir,
    });
    (terminalHost.service.captureInputState as ReturnType<typeof vi.fn>).mockResolvedValue({
      stable: true,
      currentInput: USER_DRAFT,
      observedAt: 101,
    });
    try {
      await runtime.sendTurnPrompt('queued after draft');
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();

      const nativeRuntime = envelope.nativeRuntime as ComposerClearNativeRuntime;
      const result = await nativeRuntime.clearTerminalComposer?.({ sessionId: 'happy-session-1' });

      expect(result).toMatchObject({ ok: true, status: 'cleared' });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ text: 'queued after draft' }),
      );
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});

describe('Claude Unified static inFlightConfigApplySupported capability (lane Q)', () => {
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
      await runtime.startProviderSession();
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
      await runtime.startProviderSession();
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
