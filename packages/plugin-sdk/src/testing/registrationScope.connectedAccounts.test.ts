import { describe, expect, it, vi } from 'vitest';

import type { PluginConnectedAccountRuntime } from '../services/index.js';
import { createPluginRegistrationScope } from './registrationScope.js';

function commonRuntime() {
    return {
        refresh: vi.fn(),
        revoke: vi.fn(),
        status: vi.fn(),
        materialize: vi.fn(),
    };
}

function scope() {
    return createPluginRegistrationScope({
        pluginId: 'acme.accounts',
        rights: [{
            family: 'connectedAccountDescriptors',
            localId: 'forge',
        }],
    });
}

describe('Connected Accounts registration staging', () => {
    it('snapshots every named authentication mode and its reconciliation leaf', () => {
        const runtime = {
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual',
                        complete: vi.fn(),
                    },
                    device: {
                        kind: 'oauthDeviceCode',
                        begin: vi.fn(),
                        poll: vi.fn(),
                        cancel: vi.fn(),
                        reconcile: vi.fn(),
                    },
                },
            },
            ...commonRuntime(),
        } satisfies PluginConnectedAccountRuntime;
        const registrationScope = scope();

        registrationScope.api.connectedAccounts.register('forge', runtime);

        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('connectedAccountDescriptors');
        expect(registration?.value).toEqual(runtime);
        expect(registration?.value).not.toBe(runtime);
        if (registration?.family !== 'connectedAccountDescriptors') {
            throw new Error('Expected a connected-account runtime registration');
        }
        expect(registration.value.authentication.modes).not.toBe(runtime.authentication.modes);
        expect(Object.isFrozen(registration.value.authentication.modes)).toBe(true);
        expect(Object.keys(registration.value.authentication.modes)).toEqual(['manual', 'device']);
    });

    it('rejects the retired single-mode authentication shape and malformed mode records', () => {
        const retired = scope();
        expect(() => retired.api.connectedAccounts.register('forge', {
            authentication: {
                kind: 'manual',
                complete: vi.fn(),
            },
            ...commonRuntime(),
        } as unknown as PluginConnectedAccountRuntime)).toThrow(/invalid connected-account runtime/i);

        const malformed = scope();
        expect(() => malformed.api.connectedAccounts.register('forge', {
            authentication: {
                modes: {
                    device: {
                        kind: 'oauthDeviceCode',
                        begin: vi.fn(),
                        poll: vi.fn(),
                    },
                },
            },
            ...commonRuntime(),
        } as unknown as PluginConnectedAccountRuntime)).toThrow(/invalid connected-account runtime/i);

        const invalidModeId = scope();
        expect(() => invalidModeId.api.connectedAccounts.register('forge', {
            authentication: {
                modes: {
                    ['__proto__']: {
                        kind: 'manual',
                        complete: vi.fn(),
                    },
                },
            },
            ...commonRuntime(),
        } as unknown as PluginConnectedAccountRuntime)).toThrow(/invalid connected-account runtime/i);
    });
});
