import { NotificationChannelCatalogRecordV1Schema, WebhookNotificationChannelRecordV1Schema,
    type NotificationChannelRecordV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

function slugifyWebhookChannelId(url: string): string {
    const slug = url
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return slug.length > 0 ? `webhook-${slug}` : 'webhook';
}

function ensureUniqueChannelId(channels: ReadonlyArray<Readonly<{ id: string }>>, baseId: string): string {
    const used = new Set(channels.map((channel) => channel.id));
    if (!used.has(baseId)) {
        return baseId;
    }

    let nextIndex = 2;
    while (used.has(`${baseId}-${nextIndex}`)) {
        nextIndex += 1;
    }
    return `${baseId}-${nextIndex}`;
}

/** Catalog authoring retains the incumbent endpoint identity and creation defaults. */
export function addWebhookNotificationChannelRecord(input: Readonly<{ channels: readonly NotificationChannelRecordV1[]; url: string }>): NotificationChannelRecordV1[] {
    const channel = WebhookNotificationChannelRecordV1Schema.parse({ v: 1,
        id: ensureUniqueChannelId(input.channels, slugifyWebhookChannelId(input.url)), kind: 'webhook',
        enabled: true, url: input.url.trim(), signingSecretRef: null,
        topics: { ready: true, permissionRequest: true, userActionRequest: true },
        readyIncludeMessageText: false, requestIncludeMessageText: true,
    });
    return NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [...input.channels, channel] }).channels;
}
