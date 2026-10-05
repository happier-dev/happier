import { describe, expect, it } from 'vitest';
import { createActionExecutor, DEFAULT_ATTENTION_DELIVERY_POLICY_V1, accountSettingsParse } from '@happier-dev/protocol';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createNotificationConfigurationAction } from './notificationConfigurationAction';

function accountPort() {
    let current = true;
    let writes = 0;
    let raw: Record<string, unknown> = { attentionDeliveryPolicyV1: DEFAULT_ATTENTION_DELIVERY_POLICY_V1, unrelated: 'retained' };
    // Substitute persisted Account storage only; Action admission, parsing, reducers and mirroring stay real.
    const action = createNotificationConfigurationAction({
        assertCurrent: () => { if (!current) throw Object.assign(new Error('retired'), { code: 'action_account_scope_changed' }); },
        readSettings: async () => settingsParse(raw),
        mutateRawSettings: async mutate => { const next = await mutate(raw); writes += 1; raw = next; },
    });
    // Session/daemon transports are genuine external ports. This Account-only
    // journey must not dispatch any of them; internal Action logic stays real.
    const unusedTransport = async () => { throw new Error('notification_configuration_has_no_session_or_daemon_effect'); };
    const executor = createActionExecutor({
        notificationConfigurationAction: action,
        executionRunStart: unusedTransport, executionRunList: unusedTransport, executionRunGet: unusedTransport,
        detachedExecutionRunSend: unusedTransport, executionRunStop: unusedTransport, executionRunAction: unusedTransport,
        executionRunWait: unusedTransport, sessionOpen: unusedTransport, sessionFork: unusedTransport,
        sessionRollback: unusedTransport, sessionSpawnNew: unusedTransport, pathsListRecent: unusedTransport,
        machinesList: unusedTransport, serversList: unusedTransport, reviewEnginesList: unusedTransport,
        agentsBackendsList: unusedTransport, agentsModelsList: unusedTransport, sessionSendMessage: unusedTransport,
        sessionModeSet: unusedTransport, sessionModesList: unusedTransport, sessionList: unusedTransport,
        sessionActivityGet: unusedTransport, sessionRecentMessagesGet: unusedTransport, resetGlobalVoiceAgent: unusedTransport,
        daemonMemorySearch: unusedTransport, daemonMemoryGetWindow: unusedTransport, daemonMemoryEnsureUpToDate: unusedTransport,
    });
    return { executor, raw: () => raw, writes: () => writes, retire: () => { current = false; } };
}

describe('notification configuration Actions', () => {
    it('configures a webhook through the channel and policy owner without exposing signing material', async () => {
        const owner = accountPort();
        const ctx = { surface: 'ui' as const, authority: 'present_user' as const };
        const result = await owner.executor.execute('notifications.webhooks.add', { url: ' https://hooks.example.test/notify ' }, ctx);
        expect(result).toEqual({ ok: true, result: { channelId: 'webhook-hooks-example-test-notify' } });
        const channelId = 'webhook-hooks-example-test-notify';
        await expect(owner.executor.execute('notifications.webhooks.update', { channelId, patch: {
            url: 'https://replacement.example.test/hook', topics: { ready: false }, requestIncludeMessageText: false,
        } }, ctx)).resolves.toEqual({ ok: true, result: { channelId } });
        await expect(owner.executor.execute('notifications.webhooks.signingSecret.set', { channelId, secret: ' test-only-secret ' }, ctx))
            .resolves.toEqual({ ok: true, result: { channelId } });
        const list = await owner.executor.execute('notifications.webhooks.list', {}, ctx);
        expect(list).toMatchObject({ ok: true, result: { items: [{ channelId, url: 'https://replacement.example.test/hook',
            signingSecretConfigured: true, topics: { ready: false, permissionRequest: true, userActionRequest: true } }] } });
        expect(JSON.stringify(list)).not.toContain('test-only-secret');
        expect(owner.raw().unrelated).toBe('retained');
        expect(accountSettingsParse(owner.raw()).attentionDeliveryPolicyV1.channels.webhook.events.ready?.enabled).toBe(false);
        await expect(owner.executor.execute('notifications.webhooks.signingSecret.clear', { channelId }, ctx))
            .resolves.toEqual({ ok: true, result: { channelId } });
        await expect(owner.executor.execute('notifications.webhooks.remove', { channelId }, ctx))
            .resolves.toEqual({ ok: true, result: { channelId } });
        expect(await owner.executor.execute('notifications.webhooks.list', {}, ctx)).toEqual({ ok: true, result: { items: [] } });
    });

    it('refuses invalid URLs, built-in channel edits and retired Accounts without writes', async () => {
        const owner = accountPort();
        const ctx = { surface: 'ui' as const, authority: 'present_user' as const };
        await expect(owner.executor.execute('notifications.webhooks.add', { url: 'ftp://example.test' }, ctx))
            .resolves.toMatchObject({ ok: false });
        await expect(owner.executor.execute('notifications.webhooks.update', { channelId: 'builtin:expo_push', patch: { enabled: false } }, ctx))
            .resolves.toMatchObject({ ok: false, errorCode: 'notification_webhook_not_found' });
        owner.retire();
        await expect(owner.executor.execute('notifications.webhooks.add', { url: 'https://example.test/hook' }, ctx))
            .resolves.toMatchObject({ ok: false });
        expect(owner.writes()).toBe(0);
    });
});
