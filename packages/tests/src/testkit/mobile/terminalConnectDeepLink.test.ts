import { describe, expect, it } from 'vitest';

import { resolveTerminalConnectDeepLink } from './terminalConnectDeepLink';

describe('resolveTerminalConnectDeepLink', () => {
  it('converts a terminal connect web url into an app deep link with server preserved', () => {
    expect(
      resolveTerminalConnectDeepLink(
        'https://example.test/terminal/connect#key=test-key&server=http%3A%2F%2F127.0.0.1%3A4011',
      ),
    ).toBe('happier://terminal?key=test-key&server=http%3A%2F%2F127.0.0.1%3A4011');
  });

  it('returns an empty string for non-terminal-connect urls', () => {
    expect(resolveTerminalConnectDeepLink('https://example.test/not-terminal')).toBe('');
  });

  it('can override the embedded server url with a device-visible server url', () => {
    expect(
      resolveTerminalConnectDeepLink(
        'https://example.test/terminal/connect#key=test-key&server=http%3A%2F%2F127.0.0.1%3A4011',
        { serverUrl: 'http://10.0.2.2:4011' },
      ),
    ).toBe('happier://terminal?key=test-key&server=http%3A%2F%2F10.0.2.2%3A4011');
  });
});
