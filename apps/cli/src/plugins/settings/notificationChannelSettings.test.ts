import { describe, expect, it } from 'vitest';

import {
    notificationChannelSettingFieldId,
    notificationChannelSettingsContributionId,
    resolveNotificationChannelSettingsContributions,
} from './notificationChannelSettings';

describe('notification channel settings normalization', () => {
    it('folds channel configuration into one synced canonical settings contribution', () => {
        const [settings] = resolveNotificationChannelSettingsContributions([{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.notifications',
            definition: {
                id: 'webhook',
                kind: 'webhook',
                title: 'Webhook',
                configurable: true,
                settings: [{
                    id: 'endpoint',
                    title: 'Endpoint',
                    schema: { type: 'string', minLength: 1 },
                }, {
                    id: 'token',
                    title: 'Token',
                    schema: { type: 'string' },
                    secret: true,
                }],
            },
        }]);

        expect(notificationChannelSettingsContributionId('webhook')).toBe('notification-channel/webhook');
        expect(notificationChannelSettingFieldId('webhook', 'endpoint')).toBe('webhook.endpoint');
        expect(settings).toMatchObject({
            pluginId: 'acme.notifications',
            definition: {
                id: 'notification-channel/webhook',
                target: { kind: 'plugin' },
                scope: 'synced',
                fields: [
                    { id: 'webhook.endpoint' },
                    { id: 'webhook.token', secret: true },
                ],
                presentation: {
                    sections: [{
                        id: 'configuration',
                        fields: ['webhook.endpoint', 'webhook.token'],
                    }],
                },
            },
        });
    });
});
