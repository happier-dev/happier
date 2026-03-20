import { describe, expect, test } from 'vitest';

import { runExpoMessageSocketShim } from '@/dev/webHmrOptOut/expoMessageSocketShim';

describe('expoMessageSocketShim', () => {
    test('enabled mode loads Expo messageSocket module', () => {
        const loaded: string[] = [];

        runExpoMessageSocketShim({
            isDev: true,
            hasWindow: true,
            optOut: false,
            loaders: {
                loadMessageSocket: () => {
                    loaded.push('messageSocket');
                    return {};
                },
            },
        });

        expect(loaded).toEqual(['messageSocket']);
    });

    test('opt-out mode does not load Expo messageSocket module', () => {
        const loaded: string[] = [];

        runExpoMessageSocketShim({
            isDev: true,
            hasWindow: true,
            optOut: true,
            loaders: {
                loadMessageSocket: () => {
                    loaded.push('messageSocket');
                    return {};
                },
            },
        });

        expect(loaded).toEqual([]);
    });
});
