// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { storage } from '@/sync/domains/state/storage';

const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./openExternalUrl', () => ({ openExternalUrl }));

import { installTauriExternalLinkClicks } from './installTauriExternalLinkClicks';

let restoreAuth: () => void;
beforeEach(async () => {
  restoreAuth = installSignedOutAuthForTest();
  await import('@/sync/ops/actions/defaultActionExecutor');
});

afterEach(() => {
  restoreAuth();
  document.body.replaceChildren();
  openExternalUrl.mockClear();
});

describe('installTauriExternalLinkClicks', () => {
  it('routes React Native web Linking window opens through the desktop opener', async () => {
    const originalOpen = window.open;
    const webviewOpen = vi.fn(() => null);
    window.open = webviewOpen;
    const remove = installTauriExternalLinkClicks();
    try {
      window.open('https://example.com/page', '_blank', 'noopener');
      await vi.waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/page'));
      expect(webviewOpen).not.toHaveBeenCalled();
    } finally {
      remove();
      window.open = originalOpen;
    }
  });

  it('opens a blank-target link in the system browser without navigating the webview', async () => {
    const remove = installTauriExternalLinkClicks();
    const link = document.createElement('a');
    link.href = 'https://example.com/page';
    link.target = '_blank';
    link.textContent = 'Example';
    document.body.append(link);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/page'));
    remove();
  });

  it('does not re-admit an already-owned platform continuation but refuses an explicit anchor', async () => {
    const settings = storage.getState().settings;
    storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'links.openExternal': { enabled: false } } }) } });
    const remove = installTauriExternalLinkClicks();
    try {
      window.open('https://auth.example.test/continue', '_blank', 'noopener');
      await vi.waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://auth.example.test/continue'));
      openExternalUrl.mockClear();
      const link = document.createElement('a');
      link.href = 'https://example.test/explicit';
      link.target = '_blank';
      document.body.append(link);
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const { requestOpenExternalUrl } = await import('./requestOpenExternalUrl');
      expect(await requestOpenExternalUrl(link.href)).toBe(false);
      expect(openExternalUrl).not.toHaveBeenCalled();
    } finally { remove(); storage.setState({ settings }); }
  });
});
