import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { HubStatusLineView } from './HubStatusLine';

afterEach(standardCleanup);

describe('Home status observation', () => {
    it('keeps the Home identity without claiming idle until sessions are known', async () => {
        const home = () => <>{'Home A'}</>;
        const screen = await renderScreen(<HubStatusLineView working={0} needsYou={0} isDataReady={false} home={home} />);
        expect(screen.getTextContent()).toContain('Home A');
        expect(screen.getTextContent()).not.toContain('Nothing running');
        await screen.update(<HubStatusLineView working={0} needsYou={0} isDataReady={true} home={home} />);
        expect(screen.getTextContent()).toContain('Nothing running');
    });

    it('leaves what needs the person to the attention list when that list is on the page', async () => {
        const home = () => <>{'Home A'}</>;
        const screen = await renderScreen(<HubStatusLineView working={2} needsYou={3} isDataReady={true} needsYouListed home={home} />);
        expect(screen.findByTestId('home-hub.status.needsYou')).toBeNull();
        expect(screen.findByTestId('home-hub.status.working')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Home A');
        await screen.update(<HubStatusLineView working={2} needsYou={3} isDataReady={true} home={home} />);
        expect(screen.findByTestId('home-hub.status.needsYou')).not.toBeNull();
    });
});
