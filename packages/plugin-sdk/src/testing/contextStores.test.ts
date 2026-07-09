import { describe, expect, it } from 'vitest';

import { createSettingsService } from './contextStores.js';

describe('context store test helpers', () => {
    it('notifies settings listeners for same-service-instance writes only until unsubscribed', async () => {
        const settings = createSettingsService();
        const changes: Readonly<Record<string, unknown>>[] = [];
        const subscription = settings.onChange((next) => changes.push(next));

        await settings.set('endpoint', 'https://api.example.test');
        await settings.set('enabled', true);

        expect(changes).toEqual([
            { endpoint: 'https://api.example.test' },
            { endpoint: 'https://api.example.test', enabled: true },
        ]);

        subscription.unsubscribe();
        await settings.set('endpoint', 'https://api.changed.test');

        expect(changes).toHaveLength(2);
    });
});
