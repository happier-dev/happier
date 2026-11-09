import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { renderHook } from '@/dev/testkit';
import { restoreServerAccountForTest, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope, captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { withWidgetInputRepairOutcome } from './widgetBinding';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';

// Socket transport is the external boundary; target admission and stores stay real.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

it.each([false, true])('redacts a private configured Session repair label on sharing push while retaining its binding (static choice=%s)', async (staticChoice) => {
    const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
    const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
    const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://private-widget.test', accountId: 'viewer', request: http.request });
    const viewer = getActiveServerAccountScope()!;
    const session = createSessionFixture({ id: 'private-widget', serverId: viewer.serverId, access: createSessionAccessFixture('view', { readTranscript: false }),
        metadata: { name: 'Secret invoices', path: '/private', host: 'host' } });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session }, settings: { ...storage.getState().settings,
        sessionListHiddenTagIdsWhileRecording: { [viewer.serverId]: ['secret'] } },
        sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey(viewer.serverId, session.id)]: { sessionId: session.id, tagIds: ['secret'] } } });
    const definition = { kind: 'builtin' as const, id: 'session_summary' as const };
    const baseDescriptor = readWidgetDescriptor(null, definition)!;
    const descriptor = staticChoice ? { ...baseDescriptor, inputs: { ...baseDescriptor.inputs,
        fields: baseDescriptor.inputs!.fields.map(field => ({ ...field,
            options: [{ value: { serverId: viewer.serverId, sessionId: session.id }, label: 'Secret saved choice' }] })) } } : baseDescriptor;
    const instance: WidgetInstanceV1 = { v: 1, id: 'private-copy', definition,
        bindings: { session: { kind: 'value', value: { serverId: viewer.serverId, sessionId: session.id } } } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: viewer.serverId, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    const hook = await renderHook(() => useConfiguredWidgetTarget({
        scope: { ...viewer, owner: { kind: 'home' } },
        instance, descriptor, providedContext: {}, appRuntime: runtime,
    }));
    const selectedLabel = () => {
        const result = hook.getCurrent();
        return result.status !== 'ready' && result.status !== 'loading' ? result.repair?.field?.selectedLabel : undefined;
    };
    const savedChoiceLabel = () => withWidgetInputRepairOutcome({ status: 'denied', reasonCode: 'widget_session_access_denied',
        fields: [{ path: 'session', status: 'denied', reasonCode: 'widget_session_access_denied' }] },
        { instance, descriptor, isSessionVisible: readSessionRecordingVisibility() }).repair?.field?.selectedLabel;
    try {
        expect(hook.getCurrent().status).toBe('denied');
        expect(selectedLabel()).toBe('Secret invoices');
        if (staticChoice) expect(savedChoiceLabel()).toBe('Secret saved choice');
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings,
                sessionListHiddenTagIdsWhileRecording: { [viewer.serverId]: ['secret'] } },
                sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey(viewer.serverId, session.id)]: { sessionId: session.id, tagIds: ['secret'] } } });
            setScreenSharingPrivacyActive(true);
        });
        expect(hook.getCurrent().status).toBe('denied');
        if (staticChoice) {
            expect(savedChoiceLabel()).not.toBe('Secret saved choice');
            expect(savedChoiceLabel()).toBeTruthy();
        }
        expect(selectedLabel()).not.toBe('Secret invoices');
        expect(selectedLabel()).not.toBe('Secret saved choice');
        expect(selectedLabel()).toBeTruthy();
        expect(instance.bindings.session).toEqual({ kind: 'value', value: { serverId: viewer.serverId, sessionId: session.id } });
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(selectedLabel()).toBe('Secret invoices');
    } finally { await hook.unmount(); setScreenSharingPrivacyActive(false); await connection.dispose(); }
});

