import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { SessionInvalidLinkFallback } from './SessionInvalidLinkFallback';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

beforeEach(async () => { await homes.reset(); });
afterEach(standardCleanup);

describe('Session Home chooser', () => {
    it('uses the shared Home label and leaves addresses in secondary metadata', async () => {
        const address = 'https://home.example.test';
        const unnamedId = await homes.addHome({ name: 'home.example.test', serverUrl: address, accountId: 'chooser-account' });
        const namedId = await homes.addHome({ name: 'Studio', serverUrl: 'https://studio.example.test', accountId: 'chooser-account' });
        const features = createRootLayoutFeaturesResponse();
        features.homePresentation = { v: 1, displayName: 'Published studio' };
        primeServerFeaturesSnapshot({ serverId: namedId, snapshot: { status: 'ready', features } });
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={null}>
                <SessionInvalidLinkFallback sessionId="unresolved-session" candidateServerIds={[unnamedId, namedId, 'unknown-home']} />
            </InjectedAuthProvider>,
        );
        const text = screen.getTextContent();
        expect(text).toContain('settingsAccount.thisHomeTitle');
        expect(text).toContain('Published studio');
        expect(text).not.toContain('unknown-home');
        expect(text).toContain(address);
        const renderedLabels = screen.findAllByType('Text' as never).map((node) => node.props.children);
        expect(renderedLabels).not.toContain('home.example.test');
    });
});
