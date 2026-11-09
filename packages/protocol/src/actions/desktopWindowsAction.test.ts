import { describe, expect, it } from 'vitest';
import { DesktopWindowsOpenInputSchema, DESKTOP_WINDOWS_ACTION_SPECS } from './desktopWindowsAction.js';

describe('desktop full-window admission', () => {
  const scope = { accountId: 'account', serverId: 'home-b' };

  it('admits blank, Session and destination full shells through the existing open Action and Home routing', () => {
    for (const target of [
      { kind: 'home', ...scope },
      { kind: 'session', ...scope, sessionId: 'session' },
      { kind: 'destination', ...scope, href: '/settings' },
    ]) {
      const input = DesktopWindowsOpenInputSchema.parse({ chrome: 'full', target, windowId: 'existing' });
      expect(input).toEqual({ chrome: 'full', target, windowId: 'existing' });
      expect(DESKTOP_WINDOWS_ACTION_SPECS[0].invocationServerIdForInput(input)).toBe('home-b');
    }
    expect(DesktopWindowsOpenInputSchema.parse({ target: { kind: 'session', ...scope, sessionId: 'session' } }))
      .toEqual({ target: { kind: 'session', ...scope, sessionId: 'session' } });
  });

  it('keeps blank Homes full-only and rejects moving a tab into a full shell', () => {
    expect(DesktopWindowsOpenInputSchema.safeParse({ target: { kind: 'home', ...scope } }).success).toBe(false);
    for (const target of [
      { kind: 'workspaceTab', ...scope, tabId: 'tab' },
      { kind: 'paneTab', ...scope, layoutId: 'layout', scopeId: 'scope', tabKey: 'file' },
    ]) expect(DesktopWindowsOpenInputSchema.safeParse({ chrome: 'full', target }).success).toBe(false);
  });
});
