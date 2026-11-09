import { definePlugin } from '@happier-dev/plugin-sdk';
import type { NotificationCategoryContribution } from '@happier-dev/plugin-sdk/notifications';

export const notificationButtons = [
  { id: 'Review this change ✨', label: { key: 'notice.open', fallback: 'Review' }, effect: { kind: 'open' as const } },
  { id: 'Accept #42', label: 'Accept', effect: { kind: 'action' as const, invocation: {
    action: { pluginId: 'com.acme.reviews', localId: 'accept' }, input: { item: '42' },
  } } },
] satisfies NonNullable<NotificationCategoryContribution['buttons']>;

export const notificationAuthorPlugin = definePlugin({
  id: 'com.acme.reviews', version: '1.0.0',
  actions: { accept: { title: 'Accept', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe',
    run: async () => ({ accepted: true }) } },
  notifications: { review: { title: 'Review', kind: 'plugin', eventIds: [], buttons: notificationButtons } },
});

export const noticeOnlyAuthorPlugin = definePlugin({
  id: 'com.acme.notices', version: '1.0.0',
  notifications: { notice: { title: 'Notice', kind: 'plugin', eventIds: [], buttons: [notificationButtons[0]!] } },
});
