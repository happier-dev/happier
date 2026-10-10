import * as React from 'react';
import { expect, it } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { storage } from '@/sync/domains/state/storage';
import { Item } from '@/components/ui/lists/Item';
import { ConnectedAccountPurposeTargetChooser } from './ConnectedAccountPurposeTargetChooser';

installDisconnectedServerSocketBoundary();

it('does not present an unread purpose selection as Native when its catalog is unavailable', async () => {
    const bridge = await loadSyncSingletonForTests();
    const previous = storage.getState();
    const http = createHomeHubArtifactHttpBoundary('purpose-chooser');
    const features = buildServerFeaturesResponse();
    features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://purpose-chooser.test', accountId: 'purpose-chooser',
        request: (input, init) => new URL(String(input)).pathname === '/v1/features'
            ? Promise.resolve(Response.json(features)) : http.request(input, init) });
    const scope = { serverId: connection.home.id, accountId: 'purpose-chooser' };
    storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    // Only HTTP/socket/native boundaries are replaced. Negotiation, choices,
    // purpose presentation, and the actual control remain real.
    const screen = await renderScreen(React.createElement(ConnectedAccountPurposeTargetChooser, {
        testID: 'unread-purpose', localizedTextPluginId: 'happier.agent.codex',
        declaration: { purpose: 'model', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
        value: null, disabled: true, disabledReason: 'Catalog unavailable', onChange() { throw new Error('Unread catalog must not write'); },
    }));
    try {
        expect(screen.findByType(Item).props.subtitle).toBe('Catalog unavailable');
        expect(screen.findByType(Item).props.detail).toBe('Catalog unavailable');
        expect(screen.findHostByTestId('unread-purpose')?.props.accessibilityLabel).toContain('Catalog unavailable');
    } finally { await screen.unmount(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});
