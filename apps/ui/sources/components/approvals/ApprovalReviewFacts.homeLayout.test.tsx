import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import type { HomeHubLayoutIntent } from '@happier-dev/protocol/actions/specs/homeHub';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { readActionApprovalSubject, readApprovalPreviewSummary } = await import('./actionApprovalPresentation');
const { resolveApprovalRequestTitle } = await import('./approvalRequestTitle');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { storage } = await import('@/sync/domains/state/storage');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => {
    setPreferredLanguageFromSettings('en');
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await harness.reset();
});

const summaryWidget = { v: 1, id: 'widget-1', definition: { kind: 'builtin', id: 'usage_capacity' }, bindings: {} } as const;
const summaryCases = {
    move: [{ kind: 'move', sectionId: 'reviews', step: 1 }, 'This will move an item on Home.'],
    move_to: [{ kind: 'move_to', sectionId: 'reviews', position: { nativeIndex: 0 } }, 'This will move an item on Home.'],
    reorder: [{ kind: 'reorder', sectionIds: ['start', 'reviews'] }, 'This will change the order of items on Home.'],
    visibility: [{ kind: 'visibility', sectionId: 'reviews', hidden: true }, 'This will hide an item on Home.'],
    frameStyle: [{ kind: 'frameStyle', sectionId: 'reviews', frameStyle: null }, 'This will restore the default frame style.'],
    setup_visibility: [{ kind: 'setup_visibility', stepId: 'addPhone', hidden: false }, 'This will show a setup step.'],
    restore_setup: [{ kind: 'restore_setup' }, 'This will show all setup steps again.'],
    reset: [{ kind: 'reset' }, 'This will restore the default Home layout.'],
    widget_add: [{ kind: 'widget_add', instance: summaryWidget }, 'This will add a widget to Home.'],
    widget_remove: [{ kind: 'widget_remove', instanceId: 'widget-1' }, 'This will remove a widget from Home.'],
    widget_rename: [{ kind: 'widget_rename', instanceId: 'widget-1' }, 'This will restore the default name.'],
    widget_inputs: [{ kind: 'widget_inputs', instanceId: 'widget-1', bindings: {} }, 'This will change what a widget uses.'],
    widget_inputs_reset: [{ kind: 'widget_inputs_reset', instanceId: 'widget-1' }, 'This will reset what a widget uses.'],
    widget_size: [{ kind: 'widget_size', instanceId: 'widget-1', size: 'medium' }, 'This will change a widget’s size.'],
    group_create: [{ kind: 'group_create', groupId: 'group-1', instanceIds: ['widget-1'] }, 'This will add the group “Unavailable” with Unavailable.'],
    group_add: [{ kind: 'group_add', group: { kind: 'group', id: 'group-1', width: 'full',
        children: [{ kind: 'widget', instance: summaryWidget }] } }, 'This will add a group to Home.'],
    group_ungroup: [{ kind: 'group_ungroup', instanceId: 'group-1' }, 'This will ungroup the widgets and keep them on Home.'],
    group_set: [{ kind: 'group_set', instanceId: 'group-1', width: 'full' }, 'This will change a group’s appearance.'],
    group_inputs: [{ kind: 'group_inputs', instanceId: 'group-1', bindings: {} }, 'This will change the group’s shared inputs.'],
    add: [{ kind: 'add', instance: summaryWidget }, 'This will add a widget to Home.'],
    remove: [{ kind: 'remove', instanceId: 'group-1' }, 'This will remove the selected item from Home, including its widgets if it’s a group.'],
    rename: [{ kind: 'rename', instanceId: 'group-1', displayName: 'Status' }, 'This will change the name.'],
    size: [{ kind: 'size', instanceId: 'widget-1', size: 'medium' }, 'This will change a widget’s size.'],
    width: [{ kind: 'width', instanceId: 'group-1', width: 'full' }, 'This will change a group’s width.'],
    frame: [{ kind: 'frame', instanceId: 'widget-1', frameStyle: 'plain' }, 'This will change the frame style.'],
    inputs: [{ kind: 'inputs', instanceId: 'widget-1', bindings: {} }, 'This will change what a widget uses.'],
    inputs_reset: [{ kind: 'inputs_reset', instanceId: 'widget-1' }, 'This will reset what a widget uses.'],
    network: [{ kind: 'network', instanceId: 'widget-1', network: { network: 'none' } }, 'This will change a widget’s network access.'],
} as const satisfies { readonly [K in HomeHubLayoutIntent['kind']]: readonly [Extract<HomeHubLayoutIntent, { kind: K }>, string] };

it.each([
    ...Object.values(summaryCases),
    [{ kind: 'move', instanceId: 'widget-1', groupId: 'group-1', toIndex: 0 }, 'This will move an item into a group.'],
    [{ kind: 'move', instanceId: 'widget-1', groupId: null, toIndex: 0 }, 'This will move an item to the top level of Home.'],
] as readonly (readonly [HomeHubLayoutIntent, string])[])('describes the effect of %j', (intent, expected) => {
    const actionId = 'home.hub.layout.update';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ intent });
    expect(readApprovalPreviewSummary({ summary: 'Customize Home.' }, { actionId, actionArgs, status: 'open' })).toBe(expected);
    expect(readActionApprovalSubject({ actionId, actionArgs })).toBeUndefined();
    const title = resolveApprovalRequestTitle({ storedTitle: 'Customize Home', actionId, actionArgs, status: 'open', subject: 'Machines' }).title;
    expect(title).toBe(intent.kind === 'group_create' || intent.kind === 'group_add' ? 'Add a group to Home' : 'Customize Home');
});

it('presents a Home group request in French even when the stored summary is English', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const actionId = 'home.hub.layout.update';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ intent: { ...summaryCases.group_create[0], title: 'W28 label group' } });
    expect(readApprovalPreviewSummary({ summary: 'Customize Home.' }, { actionId, actionArgs, status: 'open' }, undefined,
        ['Machines', 'Services locaux'])).toBe('Le changement prévu consiste à ajouter le groupe « W28 label group » avec Machines et Services locaux.');
    expect(readApprovalPreviewSummary({ summary: 'Customize Home.' }, { actionId, actionArgs, status: 'rejected' }, undefined,
        ['Machines', 'Services locaux'])).toBe('Le changement n’a pas été effectué. La demande visait à ajouter le groupe « W28 label group » avec Machines et Services locaux.');
});

it.each([
    ['addPhone', 'settings.addYourPhone'],
    ['67cffe92-bd4e-4b28-8512-706b1cc4ab77', null],
] as const)('reviews setup visibility by the setup step title (%s)', async (stepId, titleKey) => {
    const serverId = await harness.addHome({ name: 'Layout Home', serverUrl: 'https://layout-review.test',
        accountId: 'layout-reviewer' });
    const actionId = 'home.hub.layout.update';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ intent: { kind: 'setup_visibility', stepId, hidden: true } });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="setup-visibility-review" />);
    try {
        expect(screen.getTextContent()).toContain(titleKey ? t(titleKey) : 'Step —');
        expect(screen.getTextContent()).not.toContain(stepId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(stepId);
    } finally { await screen.unmount(); }
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
            expect(screen.getTextContent()).toContain(visibility === 'unreadable' ? (kind === 'visibility' ? 'Section —' : 'Instance —') : 'Capacity lab');
            if (kind === 'widget_rename') expect(screen.getTextContent()).toContain('Lab budget');
            expect(screen.getTextContent()).not.toContain(instanceId);
        });
        if (otherHomeId) {
            await screen.update(review(otherHomeId));
            const text = screen.getTextContent();
            expect(text).toContain(kind === 'visibility' ? 'Section —' : 'Instance —');
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
        expect(text).toContain(address === 'unreadable' ? 'Home —' : 'Design Home');
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(homeServerId);
    } finally { await screen.unmount(); }
});

it('keeps an allocated Home Group ID technical and names a saved destination on a move', async () => {
    const accountId = 'layout-reviewer';
    const serverUrl = 'https://layout-review.test';
    const serverId = await harness.addHome({ name: 'Layout Home', serverUrl, accountId, currentAccount: true });
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Missing credentials for the harness Home');
    connection = await restoreServerAccountForTest({ serverUrl, credentials, request: harness.request });
    const scope = { serverId: connection.home.id, accountId };
    storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true });
    const groupId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
    const allocatedGroupId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
    const instanceId = '9e9b44d4-2167-4837-adb5-92dc43f3b481';
    const title = 'Capacity lab';
    const actionId = 'home.hub.layout.update';
    const secondId = '84e0d949-bef5-494c-8c48-4bcb43ec4e2a';
    const createIntent = { kind: 'group_create', groupId: allocatedGroupId, instanceIds: [instanceId, secondId], title };
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const layout = createHomeHubArtifactPortV1(account.homeHubArtifactTransport, { accountId });
        await layout.apply({ kind: 'widget_add', instance: { v: 1, id: instanceId,
            definition: { kind: 'builtin', id: 'usage_capacity' }, displayName: 'Capacity Widget', bindings: {} }, size: 'medium' });
        await layout.apply({ kind: 'widget_add', instance: { v: 1, id: secondId,
            definition: { kind: 'builtin', id: 'usage_capacity' }, displayName: 'Budget Widget', bindings: {} }, size: 'medium' });
        await layout.apply({ kind: 'group_create', groupId, instanceIds: [instanceId], title });
    } finally { account.dispose(); }
    const review = (intent: unknown, capturedHomeId: string | null = scope.serverId,
        status: ApprovalRequest['status'] = 'open') => <InjectedAuthProvider credentials={credentials}>
        <ApprovalReviewFacts actionId={actionId} actionArgs={getActionSpec(actionId).inputSchema.parse({ intent })}
            preview={null} status={status} serverId={capturedHomeId} testID="home-layout-group-review" />
    </InjectedAuthProvider>;
    const create = await renderScreen(review(createIntent));
    try {
        await waitForHomeGovernance(() => expect(create.getTextContent()).toContain('This will add the group “Capacity lab” with Capacity Widget and Budget Widget.'));
        expect(create.getTextContent()).toContain(title);
        expect(create.getTextContent()).toContain('Widgets');
        expect(create.getTextContent()).not.toContain('Instance ids');
        expect(create.getTextContent()).not.toContain('Group create');
        expect(create.getTextContent()).not.toContain(allocatedGroupId);
        await create.update(review(createIntent, scope.serverId, 'rejected'));
        await waitForHomeGovernance(() => expect(create.getTextContent()).toContain(
            'The change wasn’t made. The request was to add the group “Capacity lab” with Capacity Widget and Budget Widget.'));
        await create.update(review(createIntent, null));
        expect(create.getTextContent()).toContain('This will add the group “Capacity lab” with Unavailable and Unavailable.');
        expect(create.getTextContent()).not.toContain('Capacity Widget');
        await create.pressByTestIdAsync('approvals.technical-details.header');
        expect(create.getTextContent()).toContain(allocatedGroupId);
        expect(create.getTextContent()).toContain(secondId);
    } finally { await create.unmount(); }
    const move = await renderScreen(review({ kind: 'move', instanceId, toIndex: 0, groupId }));
    try {
        await waitForHomeGovernance(() => {
            expect(move.getTextContent()).toContain(title);
            expect(move.getTextContent()).not.toContain(groupId);
        });
        await move.pressByTestIdAsync('approvals.technical-details.header');
        expect(move.getTextContent()).toContain(groupId);
    } finally { await move.unmount(); }
});

it('keeps captured Widget removal operands in Technical details', async () => {
    const instanceId = '84e0d949-bef5-494c-8c48-4bcb43ec4e2a';
    const artifactId = '7ab3eb11-cbd4-4371-890c-8b55fbe2a10c';
    const groupId = 'a44d3ea7-7277-4f6a-b1b1-2014f3a5854b';
    const actionId = 'home.hub.layout.update';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ intent: {
        kind: 'widget_remove', instanceId,
        expectedInstance: { v: 1, id: instanceId, definition: { kind: 'artifact', artifactId }, bindings: {} },
        expectedPresentation: { frameStyle: null, nativeIndex: 0, groupId },
    } });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="captured-widget-removal" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain('Instance —');
        for (const id of [instanceId, artifactId, groupId]) expect(text).not.toContain(id);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        for (const id of [instanceId, artifactId, groupId]) expect(screen.getTextContent()).toContain(id);
    } finally { await screen.unmount(); }
});

it('names a new built-in Widget and keeps an unreadable Widget artifact out of the visible card', async () => {
    const actionId = 'home.hub.layout.update';
    const instanceId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
    const artifactId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
    const builtin = { kind: 'builtin', id: 'usage_capacity' } as const;
    const descriptor = readBuiltinWidgetDescriptorV1(builtin);
    if (!descriptor) throw new Error('Expected the Capacity Widget to be registered');
    const card = (definition: unknown) => <ApprovalReviewFacts actionId={actionId}
        actionArgs={getActionSpec(actionId).inputSchema.parse({ intent: { kind: 'widget_add', size: 'medium',
            instance: { v: 1, id: instanceId, definition, bindings: {} } } })}
        preview={null} status="open" serverId={null} testID="new-widget-review" />;
    const screen = await renderScreen(card(builtin));
    try {
        expect(screen.getTextContent()).toContain(t(descriptor.titleKey));
        expect(screen.getTextContent()).not.toContain(builtin.id);
        expect(screen.getTextContent()).not.toContain(instanceId);
        await screen.update(card({ kind: 'artifact', artifactId }));
        expect(screen.getTextContent()).toContain('Artifact —');
        expect(screen.getTextContent()).not.toContain(artifactId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(artifactId);
        expect(screen.getTextContent()).toContain(instanceId);
    } finally { await screen.unmount(); }
});
