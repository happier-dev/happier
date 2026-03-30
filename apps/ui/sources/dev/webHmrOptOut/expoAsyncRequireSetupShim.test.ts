import { describe, expect, test } from 'vitest';

import { runExpoAsyncRequireSetupShim } from '@/dev/webHmrOptOut/expoAsyncRequireSetupShim';

describe('expoAsyncRequireSetupShim', () => {
    test('enabled mode loads Expo Fast Refresh + HMR setup modules', () => {
        const loaded: string[] = [];
        const loaders = {
            loadSetupFastRefresh: () => {
                loaded.push('setupFastRefresh');
                return {};
            },
            loadSetupHMR: () => {
                loaded.push('setupHMR');
                return {};
            },
            loadMessageSocket: () => {
                loaded.push('messageSocket');
                return {};
            },
            loadHmr: () => {
                loaded.push('hmr');
                return {};
            },
            loadSetup: () => {
                loaded.push('setup');
                return {};
            },
        };

        runExpoAsyncRequireSetupShim({
            isDev: true,
            hasWindow: true,
            optOut: false,
            loaders,
        });

        expect(loaded).toEqual(['setupFastRefresh', 'setupHMR', 'messageSocket']);
    });

    test('enabled mode falls back to setup module when setupFastRefresh is unavailable', () => {
        const loaded: string[] = [];
        const loaders = {
            loadSetupFastRefresh: () => {
                loaded.push('setupFastRefresh');
                throw new Error('Requiring unknown module "expo/src/async-require/setupFastRefresh"');
            },
            loadSetupHMR: () => {
                loaded.push('setupHMR');
                return {};
            },
            loadMessageSocket: () => {
                loaded.push('messageSocket');
                return {};
            },
            loadHmr: () => {
                loaded.push('hmr');
                return {};
            },
            loadSetup: () => {
                loaded.push('setup');
                return {};
            },
        };

        runExpoAsyncRequireSetupShim({
            isDev: true,
            hasWindow: true,
            optOut: false,
            loaders,
        });

        expect(loaded).toEqual(['setupFastRefresh', 'setup']);
    });

    test('opt-out mode initializes HMR client but keeps it disabled (so bundle splitting works)', () => {
        const loaded: string[] = [];
        const hmrSetupCalls: unknown[] = [];
        const loaders = {
            loadSetupFastRefresh: () => {
                loaded.push('setupFastRefresh');
                return {};
            },
            loadSetupHMR: () => {
                loaded.push('setupHMR');
                return {};
            },
            loadMessageSocket: () => {
                loaded.push('messageSocket');
                return {};
            },
            loadHmr: () => {
                loaded.push('hmr');
                return {
                    default: {
                        setup: (args: unknown) => void hmrSetupCalls.push(args),
                    },
                };
            },
            loadSetup: () => {
                loaded.push('setup');
                return {};
            },
        };

        runExpoAsyncRequireSetupShim({
            isDev: true,
            hasWindow: true,
            optOut: true,
            loaders,
        });

        expect(loaded).toEqual(['hmr']);
        expect(hmrSetupCalls).toEqual([{ isEnabled: false }]);
    });
});
