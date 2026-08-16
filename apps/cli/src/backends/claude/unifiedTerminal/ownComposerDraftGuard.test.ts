import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClaudeOwnComposerTextLog } from './ownComposerTextLog';
import { clearOwnLeftoverComposerDraft } from './ownComposerDraftGuard';
import { createClaudeUnifiedPromptInjector } from './createClaudeUnifiedPromptInjector';
import { isClaudeScreenReadyForInput } from './tuiControls/screenState';

const OWN_TEXT = 'Reply with exactly: C11-baseline-ok';

function idleScreen(draft: string): string {
  return [
    '╭───────────────────────────────────────────────╮',
    `│ > ${draft}`,
    '╰───────────────────────────────────────────────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
}

function generatingScreen(draft: string): string {
  return [
    '● Working…',
    '✶ Forging… (12s · esc to interrupt)',
    '╭───────────────────────────────────────────────╮',
    `│ > ${draft}`,
    '╰───────────────────────────────────────────────╯',
  ].join('\n');
}

function plainSuggestionScreen(suggestion: string): string {
  return [
    '────────────────────────────────────────────────',
    `❯ ${suggestion}`,
    '────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
}

function ownLog(...texts: string[]) {
  const log = createClaudeOwnComposerTextLog();
  for (const text of texts) log.record(text);
  return log;
}

function readFixture(name: string): string {
  return readFileSync(resolve(__dirname, 'tuiControls/__fixtures__', name), 'utf8');
}

describe('clearOwnLeftoverComposerDraft (C11: idle pre-injection own-leftover guard)', () => {
  it('reports no_draft for an empty composer', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen('') }),
      sendClearKey: async () => {
        throw new Error('must not clear an empty composer');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('no_draft');
  });

  it('clears an own leftover draft (seeded/recorded text) and reports cleared', async () => {
    const captures = [idleScreen(OWN_TEXT), idleScreen('')];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(clears).toBe(1);
  });

  it('clears an own collapsed paste marker whose line count matches a recent multiline injection', async () => {
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');
    const captures = [idleScreen('[Pasted text #1 +40 lines]'), idleScreen('')];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(prompt),
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(clears).toBe(1);
  });

  it('retries the bounded second clear when the first key leaves the draft behind', async () => {
    const captures = [idleScreen(OWN_TEXT), idleScreen(OWN_TEXT), idleScreen('')];
    let clears = 0;
    const attempts: number[] = [];
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
      onClearAttempt: (info) => attempts.push(info.attempt),
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 2 });
    expect(clears).toBe(2);
    expect(attempts).toEqual([1, 2]);
  });

  it('gives up after the bounded attempts and reports clear_failed', async () => {
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen(OWN_TEXT) }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('clear_failed');
    expect(clears).toBe(2);
  });

  it('NEVER touches a genuine user draft (no recorded match) and reports foreign_draft', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: idleScreen('my half-typed genuine thought'),
        cursor: { x: 33, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a genuine user draft');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
  });

  it('NEVER clears a genuine draft equal to one line of a previous multiline prompt', async () => {
    const multilinePrompt = 'first instruction line\nsecond instruction line\nthird instruction line';
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: idleScreen('second instruction line'),
        cursor: { x: 27, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a genuine user draft matching a prior prompt line');
      },
      ownComposerTexts: ownLog(multilinePrompt),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
  });

  it('NEVER clears a genuine draft equal to a previous prompt plus a one-letter suffix', async () => {
    const previousPrompt = 'please continue with the refactor';
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: idleScreen(`${previousPrompt} d`),
        cursor: { x: 37, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a genuine edited user draft');
      },
      ownComposerTexts: ownLog(previousPrompt),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
  });

  it('reports capture_style_unavailable when a plain capture has visible unowned composer text', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen('check the output') }),
      sendClearKey: async () => {
        throw new Error('must not clear unverified composer content');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('capture_style_unavailable');
  });

  it('does not let unrelated chrome styling suppress the plain-capture placeholder fallback', async () => {
    const esc = String.fromCharCode(0x1b);
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: [
          `${esc}[38;2;136;136;136m────────────────────────────────────────────────${esc}[m`,
          '❯ check the output',
          `${esc}[38;2;136;136;136m────────────────────────────────────────────────${esc}[m`,
        ].join('\n'),
      }),
      sendClearKey: async () => {
        throw new Error('must not clear unverified composer content');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('capture_style_unavailable');
  });

  it('reports no_draft for a plain Claude suggestion when tmux cursor proves the composer is empty', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: plainSuggestionScreen('what can you help me with'),
        cursor: { x: 2, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a placeholder suggestion');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('no_draft');
  });

  it('never sends the clear key while the screen is generating (Escape would interrupt the turn)', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: generatingScreen(OWN_TEXT) }),
      sendClearKey: async () => {
        throw new Error('must not press Escape while generating');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('generating');
  });

  it('reports provider_unavailable for the captured Claude usage-limit dialog instead of foreign_draft', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: readFixture('incident-89861-ratelimit-resume.ansi') }),
      sendClearKey: async () => {
        throw new Error('must not clear a usage-limit dialog');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('provider_unavailable');
  });

  it('reports blocked_non_input_state for composer-shaped dialog text instead of foreign_draft', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: [
          'Switch model?',
          '❯ 1. Yes, switch',
          '  2. No, go back',
          '',
          plainSuggestionScreen('Continue where you left off'),
        ].join('\n'),
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a non-input dialog');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('blocked_non_input_state');
  });

  it('stops clearing when the draft mutates into foreign text mid-episode (user started typing)', async () => {
    const captures = [
      { currentInput: idleScreen(OWN_TEXT) },
      { currentInput: idleScreen(`${OWN_TEXT} plus my new words`), cursor: { x: 63, y: 1 } },
    ];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => captures.shift() ?? { currentInput: idleScreen('') },
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
    expect(clears).toBe(1);
  });

  it('clears controller-vocabulary slash residue even when the registry cannot match it (RESUME2 respawn gap)', async () => {
    // Controller-typed slash commands are echo-suppressed out of the persisted transcript, so a
    // RESPAWNED runner's seeded registry can never contain them. The residue is still OUR OWN
    // (finite controller vocabulary: /model, /effort) and must clear instead of deadlocking idle
    // injection behind a foreign_draft classification forever.
    const captures = [idleScreen('/effort medium'), idleScreen('')];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      // Respawn-seeded registry: only persisted user prompts, no controller command texts.
      ownComposerTexts: ownLog('some earlier real prompt'),
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(clears).toBe(1);
  });

  it('does not report cleared when an effort residue clear is followed by a screen with no composer', async () => {
    const captures = [
      idleScreen('/effort low'),
      [
        'Applied runtime control; transcript is redrawing',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ].join('\n'),
    ];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog('some earlier real prompt'),
      wait: async () => undefined,
    });

    expect(result).toMatchObject({
      status: 'blocked_non_input_state',
      blockedReason: 'no_interactive_composer',
    });
    expect(clears).toBe(1);
  });

  it('withholds prompt bytes after clearing effort residue until a later capture has a ready composer', async () => {
    const prompt = 'exact pending prompt that must wait for the composer'.padEnd(310, '.');
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(310);
    const captures = [
      idleScreen('/effort low'),
      [
        'Applied runtime control; transcript is redrawing',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ].join('\n'),
      idleScreen(''),
    ];
    let latestGuardReady = false;
    const injectUserPrompt = vi.fn(async () => ({
      status: 'injected',
      at: 1,
      bytesWritten: Buffer.byteLength(prompt, 'utf8'),
    } as const));
    const injector = createClaudeUnifiedPromptInjector({
      inputInjection: { hostKind: 'tmux', injectUserPrompt },
      composerDraftGuard: async () => {
        const result = await clearOwnLeftoverComposerDraft({
          captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
          sendClearKey: async () => undefined,
          ownComposerTexts: ownLog('some earlier real prompt'),
          wait: async () => undefined,
        });
        latestGuardReady = 'screen' in result && isClaudeScreenReadyForInput(result.screen);
        return {
          status: result.status,
          ...(result.status === 'cleared' ? { attempts: result.attempts } : {}),
          ...(result.status === 'blocked_non_input_state'
            ? { blockedReason: result.blockedReason }
            : {}),
        };
      },
      createNonce: () => 'nonce-no-composer-after-clear',
    });
    const batch = {
      message: prompt,
      origin: { kind: 'ui_pending' as const, clientId: 'client-1' },
    };

    await expect(injector.injectPrompt(batch)).resolves.toMatchObject({
      status: 'deferred',
      reason: 'terminal_busy',
    });
    expect(injectUserPrompt).not.toHaveBeenCalled();

    await expect(injector.injectPrompt(batch)).resolves.toMatchObject({ status: 'injected' });
    expect(latestGuardReady).toBe(true);
    expect(injectUserPrompt).toHaveBeenCalledTimes(1);
    expect(injectUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ text: prompt }));
  });

  it('clears concatenated controller slash residue (/effort medium/effort medium, U1 class) after respawn', async () => {
    const captures = [idleScreen('/effort medium/effort medium'), idleScreen('')];
    let clears = 0;
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: captures.shift() ?? idleScreen('') }),
      sendClearKey: async () => {
        clears += 1;
      },
      ownComposerTexts: ownLog('some earlier real prompt'),
      wait: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(clears).toBe(1);
  });

  it('still treats non-controller slash drafts as foreign (user-typed /compact must never be cleared)', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({
        currentInput: idleScreen('/compact focus on the tests'),
        cursor: { x: 31, y: 1 },
      }),
      sendClearKey: async () => {
        throw new Error('must not clear a user-typed slash draft outside the controller vocabulary');
      },
      ownComposerTexts: ownLog('some earlier real prompt'),
      wait: async () => undefined,
    });
    expect(result.status).toBe('foreign_draft');
  });

  it.each(['/compact', ' /compact', '/compact focus on the tests'])(
    'never clears an independent user-typed %s draft',
    async (draft) => {
      let clears = 0;
      const result = await clearOwnLeftoverComposerDraft({
        captureInputState: async () => ({ currentInput: idleScreen(draft) }),
        sendClearKey: async () => {
          clears += 1;
        },
        ownComposerTexts: ownLog('some earlier real prompt'),
        wait: async () => undefined,
      });
      expect(result.status).not.toBe('cleared');
      expect(clears).toBe(0);
    },
  );

  it('reports capture_failed when the screen capture throws', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => {
        throw new Error('pane gone');
      },
      sendClearKey: async () => undefined,
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('capture_failed');
  });

  it('reports clear_failed when the clear key send throws', async () => {
    const result = await clearOwnLeftoverComposerDraft({
      captureInputState: async () => ({ currentInput: idleScreen(OWN_TEXT) }),
      sendClearKey: async () => {
        throw new Error('control port closed');
      },
      ownComposerTexts: ownLog(OWN_TEXT),
      wait: async () => undefined,
    });
    expect(result.status).toBe('clear_failed');
  });
});
