import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { storage } = await import('@/sync/domains/state/storage');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await harness.reset();
});

it.each(['readable', 'unreadable', 'other Home'] as const)('reviews the widget in a Home layout change (%s)', async visibility => {
    const accountId = 'layout-reviewer';
    const serverUrl = 'https://layout-review.test';
    const serverId = await harness.addHome({ name: 'Layout Home', serverUrl, accountId, currentAccount: true });
    const otherServerUrl = 'https://other-layout-review.test';
    const otherHomeId = visibility === 'other Home' ? await harness.addHome({
        name: 'Other Home', serverUrl: otherServerUrl, accountId: 'other-layout-reviewer', active: false,
    }) : null;
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Missing credentials for the harness Home');
    connection = await restoreServerAccountForTest({ serverUrl, credentials, request: harness.request,
        additionalRequestOrigins: otherHomeId ? [otherServerUrl] : [] });
    const scope = { serverId: connection.home.id, accountId };
    storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true });
    const instanceId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
    if (visibility !== 'unreadable') {
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await createHomeHubArtifactPortV1(account.homeHubArtifactTransport, { accountId }).apply({
                kind: 'widget_add', instance: { v: 1, id: instanceId, definition: { kind: 'builtin', id: 'usage_capacity' },
                    displayName: 'Capacity lab', bindings: {} }, size: 'medium',
            });
        } finally { account.dispose(); }
    }
    const actionId = 'home.hub.layout.update';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ intent: { kind: 'widget_rename', instanceId, displayName: 'Lab budget' } });
    const review = (capturedHomeId: string) => (
        <InjectedAuthProvider credentials={credentials}>
            <ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
                preview={null} status="open" serverId={capturedHomeId} testID="home-layout-review" />
        </InjectedAuthProvider>
    );
    const screen = await renderScreen(review(connection.home.id));
    try {
        await waitForHomeGovernance(() => {
            expect(screen.getTextContent()).toContain(visibility === 'unreadable' ? t('common.unavailable') : 'Capacity lab');
            expect(screen.getTextContent()).toContain('Lab budget');
            expect(screen.getTextContent()).not.toContain(instanceId);
        });
        if (otherHomeId) {
            await screen.update(review(otherHomeId));
            const text = screen.getTextContent();
            expect(text).toContain(t('common.unavailable'));
            expect(text).toContain('Lab budget');
            expect(text).not.toContain('Capacity lab');
            expect(text).not.toContain(instanceId);
        }
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(instanceId);
    } finally { await screen.unmount(); }
});
