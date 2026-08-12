import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnhancedMode } from '../../loop';
import { createPermissionHandlerSessionStub } from '../../utils/permissionHandler.testkit';
import { createClaudeUnifiedPromptInjector } from '../createClaudeUnifiedPromptInjector';
import { clearOwnLeftoverComposerDraft } from '../ownComposerDraftGuard';
import { createClaudeOwnComposerTextLog } from '../ownComposerTextLog';
import { createClaudeUnifiedRuntimeControlBridge } from '../runtimeControlIntegration';
import { createClaudeUnifiedTuiControlController } from '../tuiControls/controller';
import { hasClaudeUnifiedVisibleDialog } from '../tuiControls/dialogRegistry';
import { createFakeControlPort, type FakeControlPort } from '../tuiControls/fakeControlPort';
import { createClaudeSettingsGuard } from '../tuiControls/settingsGuard';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from '../tuiControls/types';
import {
  CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION,
  ClaudeUnifiedDialogChoiceBroker,
} from './claudeUnifiedDialogChoiceBroker';
import { createClaudeUnifiedDialogChoiceScreenProbe } from './claudeUnifiedDialogChoiceScreenProbe';

const EFFORT_DIALOG_MEDIUM = [
  'Change effort level?',
  'Switching to medium means the full history gets re-read before Claude can continue.',
  '❯ 1. Yes, switch to medium',
  '  2. No, go back',
].join('\n');

const EFFORT_SET_MEDIUM = [
  'Set effort level to medium',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  'Fable 5\'s safeguards flagged this message.',
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const IDLE = ['╭─────╮', '│ >   │', '╰─────╯'].join('\n');

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function captureInputState(port: FakeControlPort): Promise<{ currentInput: string }> {
  const captured = await port.captureScreen();
  if (captured.status !== 'captured') throw new Error('test terminal capture failed');
  return { currentInput: captured.capture.text };
}

async function createComposerGuard(port: FakeControlPort) {
  return clearOwnLeftoverComposerDraft({
    captureInputState: () => captureInputState(port),
    sendClearKey: async () => {
      await port.sendSpecialKey('Escape');
    },
    ownComposerTexts: createClaudeOwnComposerTextLog(),
    wait: async () => undefined,
  });
}

function projectComposerGuard(result: Awaited<ReturnType<typeof createComposerGuard>>) {
  return {
    status: result.status,
    ...(result.status === 'cleared' ? { attempts: result.attempts } : {}),
    ...(result.status === 'blocked_non_input_state' ? { blockedReason: result.blockedReason } : {}),
  };
}

function mode(overrides: Partial<EnhancedMode>): EnhancedMode {
  return { permissionMode: 'default', ...overrides };
}

describe('Claude unified pending-injection dialog routing', () => {
  it('lets slash controls resolve an owned leftover effort dialog before the composer guard', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-injection-dialog-routing-'));
    tempRoots.push(configDir);
    await writeFile(join(configDir, 'settings.json'), '{}', 'utf8');
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG_MEDIUM, EFFORT_SET_MEDIUM] });
    const controller = createClaudeUnifiedTuiControlController({
      port,
      featureEnabled: true,
      settingsGuard: createClaudeSettingsGuard({ configDir }),
      wait: async () => undefined,
      timings: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
      nowMs: () => 1_000,
    });
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: () => undefined,
      startupMode: mode({ model: 'sonnet', reasoningEffort: 'high' }),
    });
    const injectUserPrompt = vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 11 } as const));
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: { hostKind: 'tmux', injectUserPrompt },
      beforeComposerDraftGuard: async () => {
        const apply = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
        return apply.promptMayProceed
          ? null
          : { status: 'deferred', reason: 'terminal_busy', retryAfterMs: 2_000 } as const;
      },
      composerDraftGuard: async () => projectComposerGuard(await createComposerGuard(port)),
      createNonce: () => 'nonce-owned-dialog',
    });

    await expect(injector.injectPrompt({
      message: 'next prompt',
      origin: { kind: 'ui_pending', clientId: 'client-1' },
    })).resolves.toMatchObject({ status: 'injected' });

    expect(port.sentLiteral).toEqual(['1']);
    expect(port.sentKeys).toEqual([]);
    expect(injectUserPrompt).toHaveBeenCalledTimes(1);
    await bridge.dispose();
  });

  it('publishes an unowned dialog through the canonical broker and injects after its answer', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-injection-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
      createRequestId: () => 'claude_dialog_choice_pending_injection',
      nowMs: () => 123,
    });
    broker.activate();
    const port = createFakeControlPort({ captures: [SAFEGUARD_DIALOG, SAFEGUARD_DIALOG, SAFEGUARD_DIALOG, IDLE] });
    const probe = createClaudeUnifiedDialogChoiceScreenProbe({
      broker,
      port,
      wait: async () => undefined,
      graceMs: 0,
      settleMs: 0,
      verifyPollIntervalMs: 1,
      verifyPollTimeoutMs: 8,
      isDialogOwned: () => false,
    });
    const injectUserPrompt = vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 11 } as const));
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: { hostKind: 'tmux', injectUserPrompt },
      composerDraftGuard: async () => {
        const result = await createComposerGuard(port);
        if (result.status === 'blocked_non_input_state' && hasClaudeUnifiedVisibleDialog(result.screen)) {
          await probe.evaluateScreenState(result.screen);
        }
        return projectComposerGuard(result);
      },
      createNonce: () => 'nonce-unowned-dialog',
    });
    const batch = {
      message: 'next prompt',
      origin: { kind: 'ui_pending' as const, clientId: 'client-1' },
    };

    await expect(injector.injectPrompt(batch)).resolves.toMatchObject({
      status: 'deferred',
      reason: 'terminal_busy',
    });
    expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_pending_injection).toMatchObject({
      tool: 'AskUserQuestion',
      arguments: expect.objectContaining({
        happierDialog: {
          kind: 'recognized',
          dialogId: 'safeguard_pause',
          secondaryAction: 'open_terminal',
        },
      }),
    });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'claude_dialog_choice_pending_injection',
      approved: true,
      answers: { [CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION]: 'edit_prompt_and_retry' },
    });
    await vi.waitFor(() => expect(port.sentLiteral).toEqual(['2']));

    await expect(injector.injectPrompt(batch)).resolves.toMatchObject({ status: 'injected' });
    expect(injectUserPrompt).toHaveBeenCalledTimes(1);
    probe.dispose();
    broker.dispose();
  });
});
