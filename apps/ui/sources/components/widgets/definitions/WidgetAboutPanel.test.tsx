import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useWidgetPlacementLabels } from './WidgetAboutPanel';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

it('redacts private Session placement names on sharing push and restores their configured placement', async () => {
    const previous = storage.getState();
    storage.setState({ sessions: { secret: createSessionFixture({ id: 'secret', serverId: 'home', metadata: { name: 'Secret invoices', path: '/private', host: 'host' } }) },
        settings: { ...previous.settings, sessionListHiddenTagIdsWhileRecording: { home: ['secret'] } },
        sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey('home', 'secret')]: { sessionId: 'secret', tagIds: ['secret'] } } });
    const hook = await renderHook(() => useWidgetPlacementLabels({ unavailableScopes: [], placements: [{
        surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard', sessionId: 'secret' } }, instanceId: 'copy',
    }] }));
    try {
        expect(hook.getCurrent()[0]?.label).toBe('Secret invoices');
        await act(async () => setScreenSharingPrivacyActive(true));
        expect(hook.getCurrent()[0]?.label).not.toContain('Secret invoices');
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(hook.getCurrent()[0]?.label).toBe('Secret invoices');
    } finally { await hook.unmount(); setScreenSharingPrivacyActive(false); storage.setState(previous, true); }
});

it('names core-page placements alongside Home and plugin pages without exposing page ids', async () => {
    const scope = { serverId: 'home', accountId: 'viewer' };
    const hook = await renderHook(() => useWidgetPlacementLabels({ unavailableScopes: [], placements: [
        { surface: { ...scope, owner: { kind: 'home' } }, instanceId: 'home-copy' },
        { surface: { ...scope, owner: { kind: 'corePage', pageId: 'private-internal-page-id', area: 'overview' } }, instanceId: 'page-copy' },
        { surface: { ...scope, owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } }, instanceId: 'plugin-copy' },
    ] }));
    try {
        expect(hook.getCurrent()).toHaveLength(3);
        expect(hook.getCurrent().every(({ label }) => label.length > 0 && !label.includes('private-internal-page-id'))).toBe(true);
        // Each place carries its own kind's mark, so its label never repeats the kind in words.
        expect(new Set(hook.getCurrent().map(({ icon }) => icon)).size).toBe(3);
    } finally { await hook.unmount(); }
});

it('shows the friendly read label and the exact admitted Resource identity as separate lines', async () => {
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    const React = await import('react');
    const { WidgetAboutPanel } = await import('./WidgetAboutPanel');
    const screen = await renderScreen(React.createElement(WidgetAboutPanel, {
        definition: null, descriptor: null, name: 'Checks', placements: null, testID: 'about',
        sources: [{ key: 'acme.checks/bound-count', plugin: 'Acme checks', machine: null, usesViewerConnection: false,
            read: 'Bound count', identity: 'acme.checks/bound-count' }],
    }));
    try {
        const text = screen.getTextContent();
        expect(text).toContain('Bound count from Acme checks');
        expect(screen.findAllHostsByTestId('about.reads.identity').map(node => node.props.children).flat().join('')).toBe('acme.checks/bound-count');
    } finally { await act(async () => { screen.tree.unmount(); }); }
});

it('preserves a typed Refresh refusal, approval custody and a successful manual retry', async () => {
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    const React = await import('react');
    const { WidgetAboutPanel } = await import('./WidgetAboutPanel');
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const { t } = await import('@/text');
    const ref = { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } }, instanceId: 'channels' };
    let outcome: import('./widgetDefinitionCommands').WidgetDefinitionCommandOutcome<import('@happier-dev/protocol/actions/actionSpecs').PublicActionResultById['widgets.item.refresh']>
        = { kind: 'refused', errorCode: 'widget_projection_unavailable' };
    const screen = await renderScreen(React.createElement(WidgetAboutPanel, {
        definition: null, descriptor: null, name: 'Channels', placements: null, testID: 'about',
        sources: [{ key: 'happier.channels/bindings-v1', plugin: 'Channels', machine: null, usesViewerConnection: false,
            read: 'Bindings', identity: 'happier.channels/bindings-v1' }],
        onRefresh: async () => outcome,
    }));
    try {
        await screen.pressByTestIdAsync('about.refreshNow');
        expect(screen.tree.root.findByType(SurfaceStateCard).props).toMatchObject({ kind: 'unavailable', diagnosticCode: 'widget_projection_unavailable' });
        expect(screen.findAllHostsByTestId('about.refreshNow').length).toBeGreaterThan(0);
        outcome = { kind: 'approvalPending' };
        await screen.pressByTestIdAsync('about.refreshNow');
        expect(screen.tree.root.findAllByType(SurfaceStateCard)).toHaveLength(0);
        expect(screen.getTextContent()).toContain(t('widgetAdd.areaApprovalPending'));
        outcome = { kind: 'applied', result: { ref, status: 'refreshed' } };
        await screen.pressByTestIdAsync('about.refreshNow');
        expect(screen.tree.root.findAllByType(SurfaceStateCard)).toHaveLength(0);
        expect(screen.getTextContent()).toContain(t('widgetDefinition.refreshed'));
    } finally { await act(async () => { screen.tree.unmount(); }); }
});
