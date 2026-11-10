import { afterEach, expect, it, vi } from 'vitest';
import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import { Modal } from '@/modal';
import { createPluginActionInputSelectionHostApiHandler } from './pluginActionInputSelectionHostApi';

const request: PluginUiHostApiRequestEnvelopeV1 = { version: 1, requestId: 'notification-destination', surface: {
    pluginId: 'happier.machine.services', contributionId: 'health-setup', surfaceId: 'health-setup', placement: 'appSurface',
    platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
}, method: 'selectActionInput', payload: {
    hostAction: { action: 'notifications.notify_me', projection: 'notificationDestination' },
    channelId: 'happier.channel.slack/alerts',
} };
afterEach(() => vi.restoreAllMocks());

it('returns a Channels-picked destination through the bound input form without executing notify', async () => {
    const channel = { channelId: 'happier.channel.slack/alerts', destination: { connectionId: 'production',
        endpoint: { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' } } };
    const present = vi.fn<NonNullable<Parameters<typeof createPluginActionInputSelectionHostApiHandler>[0]['present']>>(
        ({ form }) => { form.replaceInput({ channel }); void form.submit(); });
    const handler = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'home', machineId: 'controller', targetPluginId: 'happier.machine.services',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) },
    }, present, composeSessionServerStartDraft: async () => ({ kind: 'cancelled' }), isCurrent: () => true });
    expect(await handler(request)).toEqual({ kind: 'notificationDestination', channel });
    expect(present).toHaveBeenCalledTimes(1);
    expect(present.mock.calls[0]?.[0].pickerContext).toMatchObject({ serverId: 'home', machineId: 'controller' });
});

it('chooses a current notification channel before opening its destination picker on first Configure', async () => {
    const channel = { channelId: 'happier.channel.slack/alerts', destination: { connectionId: 'production',
        endpoint: { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' } } };
    const present = vi.fn<NonNullable<Parameters<typeof createPluginActionInputSelectionHostApiHandler>[0]['present']>>(
        ({ form }) => {
            form.replaceInput(present.mock.calls.length === 1 ? { channelId: channel.channelId } : { channel });
            void form.submit();
        });
    const handler = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'home', machineId: 'controller', targetPluginId: 'happier.machine.services',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) },
    }, present, isCurrent: () => true });
    expect(await handler({ ...request, payload: { hostAction: {
        action: 'notifications.notify_me', projection: 'notificationDestination',
    } } })).toEqual({ kind: 'notificationDestination', channel });
    expect(present.mock.calls[0]?.[0].form.presentation.inputHints.fields).toEqual([
        expect.objectContaining({ path: 'channelId', optionsSourceId: 'notifications.channels.available' }),
    ]);
});

it('refuses destination selection when the mounted Home does not own the bound Account', async () => {
    const show = vi.spyOn(Modal, 'show');
    const handler = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'other-home', machineId: 'controller', targetPluginId: 'happier.machine.services',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) },
    }, isCurrent: () => true });
    expect(await handler(request)).toMatchObject({ code: 'unavailable' });
    expect(await handler({ ...request, payload: { hostAction: {
        action: 'notifications.notify_me', projection: 'notificationDestination',
    }, channelId: 'happier.channel.slack/alerts', target: { serverId: 'home', machineId: 'controller' } } }))
        .toMatchObject({ code: 'unavailable' });
    expect(show).not.toHaveBeenCalled();
});

it('requires a bound Account before opening the Channels destination picker', async () => {
    const show = vi.spyOn(Modal, 'show');
    const handler = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'home', machineId: 'controller', targetPluginId: 'happier.machine.services',
    }, isCurrent: () => true });
    expect(await handler(request)).toMatchObject({ code: 'unavailable' });
    expect(show).not.toHaveBeenCalled();
});

it('selects on the admitted Environment controller when Configure runs on a remote observer', async () => {
    const channel = { channelId: 'happier.channel.slack/alerts', destination: { connectionId: 'production',
        endpoint: { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' } } };
    const present = vi.fn<NonNullable<Parameters<typeof createPluginActionInputSelectionHostApiHandler>[0]['present']>>(
        ({ form }) => { form.replaceInput({ channel }); void form.submit(); });
    const handler = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'home', machineId: 'remote-observer', targetPluginId: 'happier.machine.services',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) },
    }, present, isCurrent: () => true });
    expect(await handler({ ...request, payload: { hostAction: {
        action: 'notifications.notify_me', projection: 'notificationDestination',
    }, channelId: channel.channelId, target: { serverId: 'home', machineId: 'environment-controller' } } }))
        .toEqual({ kind: 'notificationDestination', channel });
    expect(present.mock.calls[0]?.[0].pickerContext).toMatchObject({ serverId: 'home', machineId: 'environment-controller' });
});

it('refuses an explicit destination target in another Home before opening selection', async () => {
    const present = vi.fn<NonNullable<Parameters<typeof createPluginActionInputSelectionHostApiHandler>[0]['present']>>();
    const handler = createPluginActionInputSelectionHostApiHandler({ host: {
        serverId: 'home', machineId: 'remote-observer', targetPluginId: 'happier.machine.services',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) },
    }, present, isCurrent: () => true });
    expect(await handler({ ...request, payload: { hostAction: {
        action: 'notifications.notify_me', projection: 'notificationDestination',
    }, channelId: 'happier.channel.slack/alerts', target: { serverId: 'other-home', machineId: 'controller' } } }))
        .toMatchObject({ code: 'unavailable' });
    expect(present).not.toHaveBeenCalled();
});
