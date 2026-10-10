import { describe, expect, it } from 'vitest';
import { NotificationChannelCatalogRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { addWebhookNotificationChannelRecord } from './notificationChannels';

describe('notification channel catalog authoring', () => {
    it('creates a webhook with canonical record defaults and no built-in reseed or inline material', () => {
        const next = addWebhookNotificationChannelRecord({ channels: [], url: 'https://hooks.example.test/notify' });
        expect(next).toEqual(NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{
            v: 1, id: 'webhook-hooks-example-test-notify', kind: 'webhook', enabled: true,
            url: 'https://hooks.example.test/notify', signingSecretRef: null,
            topics: { ready: true, permissionRequest: true, userActionRequest: true },
            readyIncludeMessageText: false, requestIncludeMessageText: true,
        }] }).channels);
        expect(next[0]).not.toHaveProperty('signingSecret');
    });

    it('keeps existing endpoints unchanged and gives a repeated URL a distinct incumbent identity', () => {
        const first = addWebhookNotificationChannelRecord({ channels: [], url: 'https://hooks.example.test/notify' });
        const next = addWebhookNotificationChannelRecord({ channels: first, url: 'https://hooks.example.test/notify' });
        expect(next[0]).toEqual(first[0]);
        expect(next[1]?.id).toBe('webhook-hooks-example-test-notify-2');
    });
});
