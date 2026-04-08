import { describe, expect, it } from 'vitest';

import { resolveTerminalConnectUrlForBrowser } from './resolveTerminalConnectUrlForBrowser';

describe('resolveTerminalConnectUrlForBrowser', () => {
    it('preserves the exact terminal-connect hostname and port instead of rewriting it to the UI origin', () => {
        const connectUrl = 'http://127.0.0.1:52576/terminal/connect#key=abc';
        const uiBaseUrl = 'http://localhost:50983';

        expect(resolveTerminalConnectUrlForBrowser({ connectUrl, uiBaseUrl })).toBe(connectUrl);
    });

    it('appends the known server URL when the terminal-connect URL omits it', () => {
        const connectUrl = 'http://[::1]:52799/terminal/connect#key=abc';
        const uiBaseUrl = 'http://[::1]:52799';
        const serverUrl = 'http://127.0.0.1:24700';

        expect(resolveTerminalConnectUrlForBrowser({ connectUrl, uiBaseUrl, serverUrl }))
            .toBe('http://[::1]:52799/terminal/connect#key=abc&server=http%3A%2F%2F127.0.0.1%3A24700');
    });
});
