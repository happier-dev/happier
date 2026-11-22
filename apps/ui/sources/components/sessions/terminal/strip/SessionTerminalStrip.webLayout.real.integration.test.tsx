// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import type { SessionTerminalDescriptor } from '../presentation/describeSessionTerminal';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

installWebLayoutBridge();
const { SessionTerminalStrip } = await import('./SessionTerminalStrip');
const noop = () => {};

it.each([
    { width: 650, narrow: false },
    { width: 390, narrow: true },
])('keeps the shared terminal tab pointer-accessible at $width px beside trust, live link, and checkout path', async ({ width, narrow }) => {
    const terminal: SessionTerminalDescriptor = {
        terminalId: 'borrowed-web', title: 'Development checkout web service', mark: { kind: 'shell' }, status: 'running',
        detail: null, borrowed: true, url: 'http://127.0.0.1:42051/',
        place: 'Read only · /home/happier/team-projects/development/accepted-workspace/worktrees/checkout-with-a-long-name',
    };
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <HappierUiPlatformProvider platform={{ platform: 'web', colorScheme: 'light' }}>
                <View style={{ width }}>
                    <SessionTerminalStrip
                        tabs={[{ tabId: 'web', title: terminal.title, mark: terminal.mark, status: terminal.status, members: [terminal] }]}
                        activeTabId="web" listShowing={false} activeTerminal={terminal}
                        notice={{ lead: 'Runs as the Machine user', detail: 'This terminal is shared.' }}
                        narrow={narrow}
                        onActivateTab={noop} onCloseTab={noop} onTabMenu={noop} onNewShell={noop}
                        newMenuOpen={false} onNewMenuOpenChange={noop} newMenuItems={[]} onNewMenuSelect={noop}
                        canSplit={false} onSplit={noop} paneMenuItems={[]} onPaneMenuSelect={noop} onHide={noop} onOpenUrl={noop}
                    />
                </View>
            </HappierUiPlatformProvider>,
        ));
        const layout = await measureWebLayout(host, {
            viewport: { width, height: 100 }, settle: replay => act(replay),
        });
        expect(layout.rect('terminal-strip-tab-web').receivesPointer).toBe(true);
        expect(layout.rect('terminal-strip-live-pill-open').receivesPointer).toBe(true);
        expect(layout.rect('terminal-strip-hide').receivesPointer).toBe(true);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
