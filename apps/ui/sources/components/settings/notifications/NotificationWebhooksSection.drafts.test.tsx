import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { WebhookNotificationChannelV1Schema } from '@happier-dev/protocol';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { runGuardedNavigation, clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { NotificationWebhooksSection } from './NotificationWebhooksSection';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

const alert = vi.hoisted(() => vi.fn());
// This journey renders no Markdown; fail if the unavailable vendor/native SDK export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in notification draft'); },
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/notifications' }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert } }).module;
});
// Unrelated Session-envelope HTTP/process work must not run in this notification journey.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session-envelope API call'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

beforeEach(() => { alert.mockClear(); clearActiveUnsavedChangesGuard(); });

it('keeps URL and signing drafts on declined disclosure and departure, then discards when accepted', async () => {
    const channel = WebhookNotificationChannelV1Schema.parse({
        v: 1, id: 'webhook-primary', kind: 'webhook', url: 'https://hooks.example.test/notify',
    });
    const save = vi.fn();
    const screen = await renderSettingsView(<ListPresentationProvider value="page"><NotificationWebhooksSection webhookChannels={[channel]} setWebhookChannels={save} /></ListPresentationProvider>);
    act(() => screen.pressRow('settings-notifications-webhook-webhook-primary'));
    act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-edit'));
    act(() => screen.changeTextByTestId('settings-notifications-webhook-webhook-primary-url', 'https://draft.example.test/hook'));
    act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-set-secret'));
    act(() => screen.changeTextByTestId('settings-notifications-webhook-webhook-primary-secret-input', 'test-only-draft'));
    const decide = async (style: 'cancel' | 'destructive') => {
        await act(async () => {
            const buttons = alert.mock.lastCall?.[2] as ReadonlyArray<{ style: string; onPress: () => void }>;
            buttons.find(button => button.style === style)!.onPress();
        });
    };
    await act(async () => screen.pressRow('settings-notifications-webhook-webhook-primary'));
    expect(alert).toHaveBeenCalled();
    await decide('cancel');
    expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-url')!.props.value).toBe('https://draft.example.test/hook');
    expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')!.props.value).toBe('test-only-draft');
    const depart = vi.fn();
    let departure: true | Promise<boolean> = true;
    await act(async () => { departure = runGuardedNavigation(depart); });
    await decide('cancel');
    expect(await departure).toBe(false);
    expect(depart).not.toHaveBeenCalled();
    await act(async () => screen.pressRow('settings-notifications-webhook-webhook-primary'));
    await decide('destructive');
    expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-url')).toBeNull();
    expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')).toBeNull();
    act(() => screen.pressRow('settings-notifications-webhook-webhook-primary'));
    act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-set-secret'));
    act(() => screen.changeTextByTestId('settings-notifications-webhook-webhook-primary-secret-input', 'test-only-draft'));
    await act(async () => { departure = runGuardedNavigation(depart); });
    await decide('destructive');
    expect(await departure).toBe(true);
    expect(depart).toHaveBeenCalledOnce();
    expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')).toBeNull();
    act(() => screen.pressRow('settings-notifications-add-webhook'));
    act(() => screen.changeTextByTestId('settings-notifications-webhook-new-url', 'https://new-draft.example.test'));
    await act(async () => { departure = runGuardedNavigation(depart); });
    await decide('cancel');
    expect(await departure).toBe(false);
    expect(screen.findByTestId('settings-notifications-webhook-new-url')!.props.value).toBe('https://new-draft.example.test');
    await act(async () => { departure = runGuardedNavigation(depart); });
    await decide('destructive');
    expect(await departure).toBe(true);
    expect(screen.findByTestId('settings-notifications-webhook-new-url')).toBeNull();
    expect(save).not.toHaveBeenCalled();
});
