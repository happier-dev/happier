import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { t } from '@/text';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets';
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

it.each([
    ['widget_rename', 'readable'], ['widget_rename', 'unreadable'], ['widget_rename', 'other Home'],
    ['visibility', 'readable'], ['visibility', 'unreadable'], ['visibility', 'other Home'],
] as const)('names a %s target in a Home layout review (%s)', async (kind, visibility) => {
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
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ intent: kind === 'visibility'
        ? { kind, sectionId: instanceId, hidden: true }
        : { kind, instanceId, displayName: 'Lab budget' } });
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
            if (kind === 'widget_rename') expect(screen.getTextContent()).toContain('Lab budget');
            expect(screen.getTextContent()).not.toContain(instanceId);
        });
        if (otherHomeId) {
            await screen.update(review(otherHomeId));
            const text = screen.getTextContent();
            expect(text).toContain(t('common.unavailable'));
            if (kind === 'widget_rename') expect(text).toContain('Lab budget');
            expect(text).not.toContain('Capacity lab');
            expect(text).not.toContain(instanceId);
        }
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(instanceId);
    } finally { await screen.unmount(); }
});

it.each(['profile', 'portable', 'unreadable'] as const)('names the saved Home whose reachability suggestion is dismissed (%s)', async address => {
    const identity = 'srv_038b08e5-bdbd-4a26-bd08-f182e0e6580f';
    const serverId = await harness.addHome({ name: 'Design Home', serverUrl: 'https://reach-review.test',
        accountId: 'reach-reviewer', serverIdentityId: identity });
    const homeServerId = address === 'profile' ? serverId : address === 'portable'
        ? identity : 'srv_a44d3ea7-7277-4f6a-b1b1-2014f3a5854b';
    const actionId = 'home.reachNudge.dismiss';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ homeServerId });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="reach-review" />);
    try {
        const text = screen.getTextContent();
        expect(text).not.toContain(homeServerId);
        expect(text).toContain(address === 'unreadable' ? t('common.unavailable') : 'Design Home');
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(homeServerId);
    } finally { await screen.unmount(); }
});
