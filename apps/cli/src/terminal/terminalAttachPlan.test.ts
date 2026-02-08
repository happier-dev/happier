import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import type { Metadata } from '@/api/types';

import { createTerminalAttachPlan } from './terminalAttachPlan';

describe('createTerminalAttachPlan', () => {
  it('returns not-attachable when terminal mode is plain', () => {
    const terminal: NonNullable<Metadata['terminal']> = { mode: 'plain' };
    const plan = createTerminalAttachPlan({ terminal, insideTmux: false });
    expect(plan.type).toBe('not-attachable');
  });

  it('returns not-attachable when tmux mode has no target', () => {
    const terminal: NonNullable<Metadata['terminal']> = { mode: 'tmux' };
    const plan = createTerminalAttachPlan({ terminal, insideTmux: false });
    expect(plan.type).toBe('not-attachable');
  });

  it('returns not-attachable when tmux target is invalid', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'bad*:window' },
    };

    const plan = createTerminalAttachPlan({ terminal, insideTmux: false });
    expect(plan.type).toBe('not-attachable');
  });

  it('returns not-attachable when tmux target is blank', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'tmux',
      tmux: { target: '   ' },
    };

    const plan = createTerminalAttachPlan({ terminal, insideTmux: false });
    expect(plan.type).toBe('not-attachable');
  });

  it('plans select-window + attach when outside tmux', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'happy:window-1' },
    };

    const plan = createTerminalAttachPlan({ terminal, insideTmux: false });
    expect(plan).toEqual({
      type: 'tmux',
      sessionName: 'happy',
      target: 'happy:window-1',
      shouldAttach: true,
      shouldUnsetTmuxEnv: false,
      tmuxCommandEnv: {},
      selectWindowArgs: ['select-window', '-t', 'happy:window-1'],
      attachSessionArgs: ['attach-session', '-t', 'happy'],
    });
  });

  it('plans select-window only when already in tmux shared server', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'happy:window-2' },
    };

    const plan = createTerminalAttachPlan({ terminal, insideTmux: true });
    expect(plan.type).toBe('tmux');
    if (plan.type !== 'tmux') throw new Error('expected tmux plan');
    expect(plan.shouldAttach).toBe(false);
  });

  it('forces attach when tmux uses a custom tmpDir (isolated server)', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'happy:window-3', tmpDir: '/custom/tmux' },
    };

    const plan = createTerminalAttachPlan({ terminal, insideTmux: true });
    expect(plan.type).toBe('tmux');
    if (plan.type !== 'tmux') throw new Error('expected tmux plan');
    expect(plan.shouldUnsetTmuxEnv).toBe(true);
    expect(plan.tmuxCommandEnv).toEqual({ TMUX_TMPDIR: '/custom/tmux' });
    expect(plan.shouldAttach).toBe(true);
  });

  it('does not force attach when already inside the same isolated tmux server', () => {
    const uid = 501;
    const tmpDir = '/custom/tmux';
    const socketPath = join(tmpDir, `tmux-${uid}`, 'default');

    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'happy:window-4', tmpDir },
    };

    const plan = createTerminalAttachPlan({
      terminal,
      insideTmux: true,
      currentTmuxSocketPath: socketPath,
      currentUid: uid,
    });
    expect(plan.type).toBe('tmux');
    if (plan.type !== 'tmux') throw new Error('expected tmux plan');
    expect(plan.shouldUnsetTmuxEnv).toBe(false);
    expect(plan.tmuxCommandEnv).toEqual({});
    expect(plan.shouldAttach).toBe(false);
  });

  it('keeps attach flow when inside tmux but socket does not match isolated server', () => {
    const tmpDir = '/custom/tmux';
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'happy:window-4', tmpDir },
    };

    const plan = createTerminalAttachPlan({
      terminal,
      insideTmux: true,
      currentTmuxSocketPath: '/different/socket/path',
      currentUid: 501,
    });

    expect(plan.type).toBe('tmux');
    if (plan.type !== 'tmux') throw new Error('expected tmux plan');
    expect(plan.shouldUnsetTmuxEnv).toBe(true);
    expect(plan.shouldAttach).toBe(true);
    expect(plan.tmuxCommandEnv).toEqual({ TMUX_TMPDIR: '/custom/tmux' });
  });
});
