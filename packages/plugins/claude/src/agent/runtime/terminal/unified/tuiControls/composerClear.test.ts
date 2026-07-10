import { describe, expect, it } from 'vitest';

import { clearUserAuthorizedClaudeComposerDraft } from './composerClear.js';
import { createFakeControlPort } from './fakeControlPort.js';

const EMPTY_COMPOSER = [
  'Claude Code',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
].join('\n');

const USER_DRAFT = [
  'Claude Code',
  '╭─────╮',
  '│ > do not send this yet │',
  '╰─────╯',
].join('\n');

describe('clearUserAuthorizedClaudeComposerDraft', () => {
  it('clears a visible idle user draft with Escape and verifies the composer is empty', async () => {
    const port = createFakeControlPort({ captures: [USER_DRAFT, EMPTY_COMPOSER] });

    const result = await clearUserAuthorizedClaudeComposerDraft({ port, wait: async () => undefined });

    expect(result).toMatchObject({ status: 'cleared', attempts: 1 });
    expect(port.sentKeys).toEqual(['Escape']);
  });

  it('returns already_empty without sending Escape when the interactive composer is empty', async () => {
    const port = createFakeControlPort({ captures: [EMPTY_COMPOSER] });

    const result = await clearUserAuthorizedClaudeComposerDraft({ port, wait: async () => undefined });

    expect(result).toMatchObject({ status: 'already_empty' });
    expect(port.sentKeys).toEqual([]);
  });

  it.each([
    ['generating', ['✶ Forging… (10s · esc to interrupt)', '╭─────╮', '│ > queued │', '╰─────╯'].join('\n'), 'generating'],
    ['permission prompt', ['Do you want to proceed?', '1. Yes', '2. No'].join('\n'), 'permission_prompt'],
    ['permission editor', ['Permissions  Recently denied  Allow  Ask  Deny  Workspace'].join('\n'), 'permission_editor'],
    ['trust prompt', ['Do you trust the files in this folder?', '1. Yes', '2. No'].join('\n'), 'trust_prompt'],
    ['switch model dialog', ['Switch model?', '❯ 1. Yes, switch', '2. No'].join('\n'), 'switch_model_dialog'],
    ['resume choice dialog', ['This session is 18h old and 560.4k tokens', '❯ 1. Resume from summary', '2. Resume full session'].join('\n'), 'resume_choice_dialog'],
    ['effort dialog', ['Change effort level?', '❯ 1. Yes, switch to high', '2. No'].join('\n'), 'effort_change_dialog'],
    ['unknown numbered dialog', ['Something new?', '❯ 1. Continue', '2. Cancel'].join('\n'), 'unrecognized_confirmation_dialog'],
    ['slash picker', ['╭─────╮', '│ > /model │', '╰─────╯', '/model — switch model'].join('\n'), 'slash_picker'],
    ['selection list', ['↑/↓ to select', '❯ ◯ worker review'].join('\n'), 'selection_list'],
    ['no composer', ['Claude Code', 'transcript only'].join('\n'), 'no_interactive_composer'],
  ])('refuses to clear while %s is visible', async (_label, screen, reason) => {
    const port = createFakeControlPort({ captures: [screen] });

    const result = await clearUserAuthorizedClaudeComposerDraft({ port, wait: async () => undefined });

    expect(result).toMatchObject({ status: 'refused', reason });
    expect(port.sentKeys).toEqual([]);
  });

  it('stops after a bounded number of Escape attempts when the draft remains', async () => {
    const port = createFakeControlPort({ captures: [USER_DRAFT, USER_DRAFT, USER_DRAFT] });

    const result = await clearUserAuthorizedClaudeComposerDraft({
      port,
      wait: async () => undefined,
      maxAttempts: 2,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'clear_failed' });
    expect(port.sentKeys).toEqual(['Escape', 'Escape']);
  });

  it('reports capture and send failures without retrying unsafe assumptions', async () => {
    const captureFailing = createFakeControlPort({
      captures: [USER_DRAFT],
      failCaptureAtIndexes: [0],
    });
    await expect(clearUserAuthorizedClaudeComposerDraft({
      port: captureFailing,
      wait: async () => undefined,
    })).resolves.toMatchObject({ status: 'failed', reason: 'host_dead:unrecoverable' });

    const sendFailing = createFakeControlPort({
      captures: [USER_DRAFT],
      failSendKeys: ['Escape'],
    });
    await expect(clearUserAuthorizedClaudeComposerDraft({
      port: sendFailing,
      wait: async () => undefined,
    })).resolves.toMatchObject({ status: 'failed', reason: 'host_dead:unrecoverable' });
    expect(sendFailing.sentKeys).toEqual(['Escape']);
  });
});
