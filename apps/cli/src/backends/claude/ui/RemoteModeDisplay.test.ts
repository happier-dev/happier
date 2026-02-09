import { describe, expect, it } from 'vitest';

import { interpretRemoteModeKeypress } from './RemoteModeDisplay';

describe('RemoteModeDisplay input handling', () => {
  it('switches immediately on Ctrl+T', () => {
    const result = interpretRemoteModeKeypress({ confirmationMode: null, actionInProgress: null }, 't', { ctrl: true });
    expect(result.action).toBe('switch');
  });

  it('requires double space to switch when using spacebar', () => {
    const first = interpretRemoteModeKeypress({ confirmationMode: null, actionInProgress: null }, ' ', {});
    expect(first.action).toBe('confirm-switch');

    const second = interpretRemoteModeKeypress({ confirmationMode: 'switch', actionInProgress: null }, ' ', {});
    expect(second.action).toBe('switch');
  });

  it('requires double Ctrl+C to confirm full exit', () => {
    const first = interpretRemoteModeKeypress({ confirmationMode: null, actionInProgress: null }, 'c', { ctrl: true });
    expect(first.action).toBe('confirm-exit');

    const second = interpretRemoteModeKeypress({ confirmationMode: 'exit', actionInProgress: null }, 'c', { ctrl: true });
    expect(second.action).toBe('exit');
  });

  it('resets confirmation mode on unrelated keypress', () => {
    const result = interpretRemoteModeKeypress({ confirmationMode: 'switch', actionInProgress: null }, 'x', {});
    expect(result.action).toBe('reset');
  });

  it('ignores keypresses while an action is in progress', () => {
    const switchWhileBusy = interpretRemoteModeKeypress({ confirmationMode: null, actionInProgress: 'switching' }, 't', { ctrl: true });
    expect(switchWhileBusy.action).toBe('none');

    const exitWhileBusy = interpretRemoteModeKeypress({ confirmationMode: 'exit', actionInProgress: 'exiting' }, 'c', { ctrl: true });
    expect(exitWhileBusy.action).toBe('none');
  });

  it('returns none for non-control keys when there is no confirmation state', () => {
    const result = interpretRemoteModeKeypress({ confirmationMode: null, actionInProgress: null }, 'a', {});
    expect(result.action).toBe('none');
  });

  it('does not trigger local switch controls when switch-to-local is disabled', () => {
    const ctrlT = (interpretRemoteModeKeypress as any)(
      { confirmationMode: null, actionInProgress: null },
      't',
      { ctrl: true },
      { allowSwitchToLocal: false },
    );
    expect(ctrlT.action).toBe('none');

    const space = (interpretRemoteModeKeypress as any)(
      { confirmationMode: null, actionInProgress: null },
      ' ',
      {},
      { allowSwitchToLocal: false },
    );
    expect(space.action).toBe('none');
  });
});
