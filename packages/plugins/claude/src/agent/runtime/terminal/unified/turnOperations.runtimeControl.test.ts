import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

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
const GENERATING = ['● working', '✶ Forging… (10s · esc to interrupt)', '╭─────╮', '│ >   │', '╰─────╯', '  ⏸ manual'].join('\n');
const GEN_ACCEPT = [
  '● working',
  '✶ Forging… (12s · esc to interrupt)',
  '╭─────╮', '│ >   │', '╰─────╯',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const USAGE_LIMIT_DIALOG = readFileSync(
  join(fixturesDir, 'incident-89861-ratelimit-resume.ansi'),
  'utf8',
);

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
  initialModelId?: string;
  providerModel?: AgentSessionProviderBinding['model'];
  workspaceWrites?: 'allow' | 'deny';
  publishSessionEvent?: ReturnType<typeof vi.fn>;
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
    ...(params.publishSessionEvent ? { publishSessionEvent: params.publishSessionEvent } : {}),
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
    workspaceWrites: params.workspaceWrites,
    ...(params.initialModelId ? { initialModelId: params.initialModelId } : {}),
    ...(params.providerModel ? { providerModel: params.providerModel } : {}),
    tuiControl: { timings: FAST_TIMINGS },
  }));
  return { envelope, runtime: envelope.operations, fakePort, terminalHost, ctx };
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

type ConnectedServiceApplicationNativeRuntime = Readonly<{
  connectedServiceApplicationSettled?: () => Promise<void>;
  setOnPromptDeliveryBlockerCleared?: (handler: () => void) => void;
}>;

describe('Claude Unified TUI runtime control integration (updateSessionRuntimeConfig)', () => {
  it.each(['model', 'effort'])('restores the requested %s after an unverified command instead of retaining its pending override', async kind => {
    const captures = [IDLE, IDLE, IDLE];
    const { runtime, ctx, fakePort, terminalHost } = buildRuntime({
      configDir: await makeConfigDir(), featureEnabled: true,
      initialModelId: 'claude-sonnet-4-6', controlPortCaptures: captures,
    });
    try {
      await runtime.startProviderSession();
      const hookOptions = (ctx.agentRuntime.sessionHooks.startServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        onStatuslineUpdate(payload: Readonly<Record<string, unknown>>): Promise<void>;
      };
      await hookOptions.onStatuslineUpdate({ model: { id: 'claude-sonnet-4-6' }, effort: { level: 'high' } });
      const changedUpdate = kind === 'model' ? { modelId: 'claude-opus-4-8' }
        : { configOption: { id: 'reasoning_effort', value: 'medium' } };
      const restoredUpdate = kind === 'model' ? { modelId: 'claude-sonnet-4-6' }
        : { configOption: { id: 'reasoning_effort', value: 'high' } };
      const expectedCommands = kind === 'model'
        ? ['/model claude-opus-4-8', '/model claude-sonnet-4-6']
        : ['/effort medium', '/effort high'];
      await expect(runtime.updateSessionRuntimeConfig(changedUpdate))
        .resolves.toMatchObject({ status: 'applied', timing: 'queued_until_safe_window' });
      expect(fakePort?.sentLiteral).toEqual(expectedCommands.slice(0, 1));

      captures.splice(0, captures.length, ...Array<string>(fakePort?.captureCount() ?? 0).fill(IDLE),
        IDLE, IDLE, kind === 'model'
          ? ['Set model to Sonnet 4.6', '╭─────╮', '│ >   │', '╰─────╯'].join('\n') : EFFORT_OK);
      const restore = await runtime.updateSessionRuntimeConfig(restoredUpdate);
      expect(restore).toMatchObject({ status: 'applied' });
      expect(restore?.timing).not.toBe('skipped_already_effective');
      await runtime.sendTurnPrompt('continue on the restored model');
      expect(fakePort?.sentLiteral).toEqual(expectedCommands);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally { await runtime.resetOrDisposeRuntime(); }
  });

  it.each(['model', 'effort', 'ultracode'])('does not reuse older statusline truth after repeated verified %s controls', async kind => {
    const initialModelId = kind === 'ultracode' ? 'claude-opus-4-7' : 'claude-sonnet-4-6';
    const firstConfirmation = kind === 'model'
      ? ['Set model to Opus 4.8', '╭─────╮', '│ >   │', '╰─────╯'].join('\n')
      : [kind === 'effort' ? 'Set reasoning effort to medium' : 'Set effort level to ultracode', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
    const restoreConfirmation = kind === 'model'
      ? ['Set model to Sonnet 4.6', '╭─────╮', '│ >   │', '╰─────╯'].join('\n')
      : EFFORT_OK;
    const { envelope, runtime, ctx, fakePort } = buildRuntime({ configDir: await makeConfigDir(), featureEnabled: true,
      initialModelId, controlPortCaptures: [
        IDLE, IDLE, firstConfirmation, IDLE, IDLE, restoreConfirmation,
        IDLE, IDLE, firstConfirmation, IDLE, IDLE, restoreConfirmation,
      ] });
    const observations: unknown[] = [];
    envelope.nativeRuntime.subscribeEffectiveModel(evidence => observations.push(evidence));
    try {
      if (kind === 'ultracode') {
        await runtime.updateSessionRuntimeConfig({ configOption: { id: 'reasoning_effort', value: 'high' } });
      }
      await runtime.startProviderSession();
      const hookOptions = (ctx.agentRuntime.sessionHooks.startServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        onStatuslineUpdate(payload: Readonly<Record<string, unknown>>): Promise<void>;
      };
      await hookOptions.onStatuslineUpdate({ model: { id: initialModelId }, effort: { level: 'high' } });
      const firstUpdate = kind === 'model' ? { modelId: 'claude-opus-4-8' }
        : { configOption: { id: kind === 'effort' ? 'reasoning_effort' : 'ultracode', value: kind === 'effort' ? 'medium' : true } };
      const restoreUpdate = kind === 'model' ? { modelId: 'claude-sonnet-4-6' }
        // Regular effort preserves selected ultracode; its off toggle restores the selected high effort.
        : { configOption: { id: kind === 'effort' ? 'reasoning_effort' : 'ultracode', value: kind === 'effort' ? 'high' : false } };
      await expect(runtime.updateSessionRuntimeConfig(firstUpdate)).resolves.toMatchObject({ status: 'applied' });
      const firstObservation = observations.at(-1);
      expect(firstObservation).toBeDefined();
      const restore = await runtime.updateSessionRuntimeConfig(restoreUpdate);
      expect(restore).toMatchObject({ status: 'applied' });
      expect(restore?.timing).not.toBe('skipped_already_effective');
      await expect(runtime.updateSessionRuntimeConfig(firstUpdate)).resolves.toMatchObject({ status: 'applied' });
      expect(observations.at(-1)).toEqual(firstObservation);
      const repeatedRestore = await runtime.updateSessionRuntimeConfig(restoreUpdate);
      expect(repeatedRestore).toMatchObject({ status: 'applied' });
      expect(repeatedRestore?.timing).not.toBe('skipped_already_effective');
      const expectedCommands = kind === 'model'
        ? ['/model claude-opus-4-8', '/model claude-sonnet-4-6']
        : [kind === 'effort' ? '/effort medium' : '/effort ultracode', '/effort high'];
      expect(fakePort?.sentLiteral).toEqual([...expectedCommands, ...expectedCommands]);
    } finally { await runtime.resetOrDisposeRuntime(); }
  });

  it('keeps a launch-only model equality deferred until authenticated native evidence confirms it', async () => {
    const { runtime, ctx } = buildRuntime({ configDir: await makeConfigDir(), featureEnabled: false, initialModelId: 'claude-opus-4-8' });
    try {
      await runtime.startProviderSession();
      await expect(runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' }))
        .resolves.toMatchObject({ status: 'applied', timing: 'before_next_prompt' });
      const hookOptions = (ctx.agentRuntime.sessionHooks.startServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        onStatuslineUpdate(payload: Readonly<Record<string, unknown>>): Promise<void>;
      };
      await hookOptions.onStatuslineUpdate({ model: { id: 'claude-opus-4-8' } });
      await expect(runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' }))
        .resolves.toMatchObject({ status: 'applied', timing: 'skipped_already_effective' });
    } finally { await runtime.resetOrDisposeRuntime(); }
  });

  it.each([
    { providerBound: false, modelId: 'default', fallbackModel: 'default' },
    { providerBound: true, modelId: 'default', fallbackModel: 'gateway-fallback' },
    { providerBound: true, modelId: 'gateway-selected', fallbackModel: 'default' },
  ])('preserves the native reset or opaque Provider default selector at terminal launch ($providerBound, $modelId, $fallbackModel)', async ({ providerBound, modelId, fallbackModel }) => {
    const binding = { connectionId: ProviderConnectionIdSchema.parse('pc_terminal_default'),
      model: { id: modelId, name: 'Opaque default' }, materialization: { v: 1 as const, kind: 'spawnEnv' as const } };
    const { runtime, terminalHost } = buildRuntime({
      configDir: await makeConfigDir(), featureEnabled: false, initialModelId: 'gateway-selected',
      ...(providerBound ? { providerModel: { id: 'gateway-selected', name: 'Gateway model' } } : {}),
    });
    try {
      await runtime.updateSessionRuntimeConfig({ fallbackModel: 'gateway-fallback' });
      await runtime.updateSessionRuntimeConfig({ modelId, fallbackModel,
        ...(providerBound ? { providerBinding: binding } : {}),
      });
      await runtime.startProviderSession();
      const args = (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].launch.args ?? [];
      if (providerBound) {
        expect(args).toEqual(expect.arrayContaining(['--model', modelId, '--fallback-model', fallbackModel]));
      } else {
        expect(args).not.toContain('--model');
        expect(args).not.toContain('--fallback-model');
      }
      await expect(runtime.updateSessionRuntimeConfig({ modelId, fallbackModel,
        ...(providerBound ? { providerBinding: binding } : {}),
      })).resolves.toMatchObject({ status: 'applied', timing: 'before_next_prompt' });
    } finally { await runtime.resetOrDisposeRuntime(); }
  });

  it.each([undefined, 'allow', 'deny'] as const)('keeps the effective workspace-write policy after terminal launch (%s)', async (workspaceWrites) => {
    const configDir = await makeConfigDir();
    const { runtime } = buildRuntime({ featureEnabled: true, configDir, workspaceWrites });
    const effective = workspaceWrites ?? 'allow';
    try {
      await runtime.startProviderSession();
      await expect(runtime.updateSessionRuntimeConfig({ workspaceWrites: effective })).resolves.toMatchObject({
        status: 'applied', timing: 'skipped_already_effective',
      });
      await expect(runtime.updateSessionRuntimeConfig({ workspaceWrites: effective === 'allow' ? 'deny' : 'allow' })).resolves.toMatchObject({
        status: 'requires_restart', reason: 'role_policy_restart_required',
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

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
    const publishSessionEvent = vi.fn(async () => ({ status: 'custodied' as const }));
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE, IDLE, EFFORT_OK],
      configDir,
      initialModelId: 'claude-sonnet-4-6',
      publishSessionEvent,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'high' },
      });
      expect(outcome).toMatchObject({ status: 'applied' });
      expect(fakePort?.sentLiteral).toContain('/effort high');
      // Outcome events ride the runtime-config-outcome session-event contract.
      expect(publishSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'runtime-config-outcome',
        runtime: 'claude-unified-terminal',
        status: 'applied',
        changes: [expect.objectContaining({ key: 'reasoningEffort', effective: 'high' })],
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it.each([undefined, 'allow', 'deny'] as const)('applies a permission-mode override while preserving the admitted workspace policy (%s)', async (workspaceWrites) => {
    const configDir = await makeConfigDir();
    const publishSessionEvent = vi.fn(async () => ({ status: 'custodied' as const }));
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [IDLE, ACCEPT_EDITS_IDLE],
      configDir,
      publishSessionEvent,
      workspaceWrites,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        permissionMode: 'acceptEdits',
        ...(workspaceWrites ? { workspaceWrites } : {}),
      });

      expect(outcome).toMatchObject({ status: 'applied' });
      expect(fakePort?.sentKeys).toEqual(['ShiftTab']);
      expect(fakePort?.sentLiteral.some((text) => text.startsWith('/permissions'))).toBe(false);
      expect(publishSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'runtime-config-outcome',
        runtime: 'claude-unified-terminal',
        status: 'applied',
        changes: [expect.objectContaining({ key: 'permissionMode', effective: 'acceptEdits' })],
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies a metadata-only mode-only permission change during generation through the mode-cycle window', async () => {
    const configDir = await makeConfigDir();
    const publishSessionEvent = vi.fn(async () => ({ status: 'custodied' as const }));
    const { runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [GENERATING, GEN_ACCEPT],
      configDir,
      publishSessionEvent,
    });
    try {
      await runtime.startProviderSession();
      const outcome = await runtime.updateSessionRuntimeConfig({
        permissionMode: 'acceptEdits',
      });

      expect(outcome).toMatchObject({ status: 'applied' });
      expect(fakePort?.sentKeys).toEqual(['ShiftTab']);
      expect(publishSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'runtime-config-outcome',
        runtime: 'claude-unified-terminal',
        status: 'applied',
        changes: [expect.objectContaining({ key: 'permissionMode', effective: 'acceptEdits' })],
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
        permissionMode: 'dontAsk',
      });

      expect(outcome).toMatchObject({
        status: 'requires_restart',
        reason: 'mode_not_cycle_reachable:dontAsk',
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
  it('returns the existing not_safe protocol status without Escape for an automatic usage-limit wait', async () => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures: [[USER_DRAFT, '    Continuing automatically at 5:10pm · esc to cancel'].join('\n')],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const nativeRuntime = envelope.nativeRuntime as ComposerClearNativeRuntime;

      expect(await nativeRuntime.clearTerminalComposer?.({ sessionId: 'happy-session-1' })).toMatchObject({
        ok: false, status: 'not_safe', sessionId: 'happy-session-1',
      });
      expect(fakePort?.sentKeys).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

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

describe('Claude Unified connected-service application settlement', () => {
  it.each([true, false])('releases a chooser only at prompt injection (exact application: %s)', async (exactApplication) => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, fakePort, terminalHost } = buildRuntime({
      featureEnabled: false,
      controlPortCaptures: [USAGE_LIMIT_DIALOG, IDLE],
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const nativeRuntime = envelope.nativeRuntime as ConnectedServiceApplicationNativeRuntime;

      if (exactApplication) {
        const capturesBeforeApplication = fakePort?.captureCount();
        await Promise.all([
          nativeRuntime.connectedServiceApplicationSettled?.(),
          nativeRuntime.connectedServiceApplicationSettled?.(),
        ]);
        expect(fakePort?.captureCount()).toBe(capturesBeforeApplication);
      }
      expect(fakePort?.sentKeys).toEqual([]);
      (terminalHost.service.captureInputState as ReturnType<typeof vi.fn>).mockResolvedValue({
        stable: true, currentInput: USAGE_LIMIT_DIALOG, observedAt: 101,
      });
      vi.mocked(terminalHost.service.injectUserPrompt).mockImplementation(async (_handle, input) => {
        expect(fakePort?.sentKeys).toEqual(['Escape']);
        expect(fakePort?.captureCount()).toBeGreaterThanOrEqual(2);
        return { status: 'injected', injectedAt: 102, bytesWritten: input.text.length,
          hostKind: terminalHost.handle.kind, hostSessionName: terminalHost.handle.sessionName };
      });
      await runtime.sendTurnPrompt('continue after recovery');
      expect(fakePort?.sentKeys).toEqual(['Escape']);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledOnce();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('defers prompt bytes when Escape does not close the chooser', async () => {
    const { runtime, fakePort, terminalHost } = buildRuntime({
      featureEnabled: false, controlPortCaptures: [USAGE_LIMIT_DIALOG], configDir: await makeConfigDir(),
    });
    try {
      await runtime.startProviderSession();
      (terminalHost.service.captureInputState as ReturnType<typeof vi.fn>).mockResolvedValue({
        stable: true, currentInput: USAGE_LIMIT_DIALOG, observedAt: 101,
      });
      await runtime.sendTurnPrompt('must wait for closure');
      expect(fakePort?.sentKeys).toEqual(['Escape']);
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
    } finally { await runtime.resetOrDisposeRuntime(); }
  });

  it.each([[IDLE], null])('wakes Pending without terminal effects on a healthy screen (%j)', async (controlPortCaptures) => {
    const configDir = await makeConfigDir();
    const { envelope, runtime, fakePort } = buildRuntime({
      featureEnabled: true,
      controlPortCaptures,
      configDir,
    });
    try {
      await runtime.startProviderSession();
      const nativeRuntime = envelope.nativeRuntime as ConnectedServiceApplicationNativeRuntime;
      const wakePending = vi.fn();
      nativeRuntime.setOnPromptDeliveryBlockerCleared?.(wakePending);

      await nativeRuntime.connectedServiceApplicationSettled?.();

      expect(fakePort?.sentKeys ?? []).toEqual([]);
      expect(wakePending).toHaveBeenCalledOnce();
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
