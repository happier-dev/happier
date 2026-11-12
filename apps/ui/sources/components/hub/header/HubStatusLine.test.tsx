import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { HubStatusLineView } from './HubStatusLine';

afterEach(standardCleanup);

describe('Home status observation', () => {
    it('keeps the Home identity without claiming idle until sessions are known', async () => {
        const home = () => <>{'Home A'}</>;
        const screen = await renderScreen(<HubStatusLineView working={0} inbox={0} isDataReady={false} home={home} />);
        expect(screen.getTextContent()).toContain('Home A');
        expect(screen.getTextContent()).not.toContain('Nothing running');
        await screen.update(<HubStatusLineView working={0} inbox={0} isDataReady={true} home={home} />);
        expect(screen.getTextContent()).toContain('Nothing running');
    });

    it('leaves Inbox to the attention section when Home already presents it', async () => {
        const screen = await renderScreen(<HubStatusLineView working={2} inbox={8} inboxPresented home={() => <>Home A</>} />);
        expect(screen.findByTestId('home-hub.status.inbox')).toBeNull();
        expect(screen.findByTestId('home-hub.status.working')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Home A');
    });

    it('says what waits in the Inbox at the fold and opens the Inbox, leaving out a count still being read', async () => {
        const home = () => <>{'Home A'}</>;
        const openInbox = vi.fn();
        const screen = await renderScreen(<HubStatusLineView working={2} inbox={8} onOpenInbox={openInbox} isDataReady={true} home={home} />);
        const inbox = screen.findByTestId('home-hub.status.inbox');
        expect(inbox).not.toBeNull();
        expect(screen.getTextContent()).toContain('8 waiting in your Inbox');
        inbox!.props.onPress();
        expect(openInbox).toHaveBeenCalledTimes(1);
        await screen.update(<HubStatusLineView working={2} inbox={null} onOpenInbox={openInbox} isDataReady={true} home={home} />);
        expect(screen.findByTestId('home-hub.status.inbox')).toBeNull();
        expect(screen.findByTestId('home-hub.status.working')).not.toBeNull();
    });
});
