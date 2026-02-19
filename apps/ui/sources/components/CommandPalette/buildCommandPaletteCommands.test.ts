import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import type { Command } from './types';
import { buildCommandPaletteCommands } from './buildCommandPaletteCommands';

const createSessionActionDraftSpy = vi.fn();
let mockedState: any = null;
vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => mockedState,
  },
}));

function commandTitles(cmds: readonly Command[]): string[] {
  return cmds.map((c) => c.title);
}

describe('buildCommandPaletteCommands', () => {
  it('includes ActionSpec-derived commands when enabled (execution runs + voice)', async () => {
    const pushes: string[] = [];
    const executorCalls: Array<{ actionId: string }> = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: true, memorySearchEnabled: false },
      nav: {
        push: (path) => pushes.push(path),
        navigateToSession: () => {},
      },
      auth: {
        logout: async () => {},
      },
      actions: {
        execute: async (actionId) => {
          executorCalls.push({ actionId });
          return { ok: true, result: {} };
        },
      },
      alert: async () => {},
    });

    expect(commandTitles(cmds)).toEqual(
      expect.arrayContaining([
        'Start review run',
        'Start plan run',
        'Start delegation run',
        'Open session runs',
        'Reset voice agent',
      ]),
    );

    const reset = cmds.find((c) => c.title === 'Reset voice agent');
    expect(reset).toBeTruthy();
    await reset!.action();
    expect(executorCalls).toEqual([{ actionId: 'ui.voice_global.reset' }]);

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();
    await startReview!.action();
    expect(createSessionActionDraftSpy).toHaveBeenCalled();
  });

  it('shows an alert when a session-scoped ActionSpec command is used without an active session', async () => {
    const alerts: Array<{ title: string; message: string }> = [];
    const pushes: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: (path) => pushes.push(path),
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async (title, message) => {
        alerts.push({ title, message });
      },
    });

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();

    await startReview!.action();
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.title).toContain('Session required');
    expect(pushes).toEqual([]);
  });

  it('does not inject coderabbit-specific config into review.start drafts', async () => {
    createSessionActionDraftSpy.mockClear();
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {
        'session-1': { id: 'session-1', metadata: { agent: 'coderabbit', name: 'x' } },
      },
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const startReview = cmds.find((c) => c.title === 'Start review run');
    expect(startReview).toBeTruthy();

    await startReview!.action();
    expect(createSessionActionDraftSpy).toHaveBeenCalledTimes(1);

    const call = createSessionActionDraftSpy.mock.calls[0] ?? [];
    const created = call[1] as any;
    expect(created?.actionId).toBe('review.start');
    expect(created?.input?.engineIds).toEqual(['coderabbit']);
    expect(created?.input?.engines).toBeUndefined();
  });

  it('omits command_palette actions when disabled for that placement', async () => {
    mockedState = {
      createSessionActionDraft: createSessionActionDraftSpy,
      settings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'review.start': { disabledPlacements: ['command_palette'] },
          },
        },
      },
    };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: 'session-1',
      features: { executionRunsEnabled: true, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(commandTitles(cmds)).not.toEqual(expect.arrayContaining(['Start review run']));
  });

  it('includes a memory search navigation command when enabled', async () => {
    const pushes: string[] = [];
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: true },
      nav: {
        push: (path) => pushes.push(path),
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    const cmd = cmds.find((c) => c.id === 'memory-search');
    expect(cmd).toBeTruthy();
    await cmd!.action();
    expect(pushes).toEqual(['/search']);
  });

  it('omits the memory search navigation command when disabled', async () => {
    mockedState = { createSessionActionDraft: createSessionActionDraftSpy, settings: {} };

    const cmds = buildCommandPaletteCommands({
      sessionsById: {},
      isDev: false,
      activeSessionId: null,
      features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
      nav: {
        push: () => {},
        navigateToSession: () => {},
      },
      auth: { logout: async () => {} },
      actions: { execute: async () => ({ ok: true, result: {} }) },
      alert: async () => {},
    });

    expect(cmds.some((c) => c.id === 'memory-search')).toBe(false);
  });
});
