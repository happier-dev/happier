import { describe, expect, it, vi } from 'vitest';
import type { PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/protocol';

import type { PluginConnectedAccountRuntime } from '../services/index.js';
import {
    createPluginRegistrationScope,
} from '../host/registration/index.js';

function commonRuntime() {
    return {
        refresh: vi.fn(),
        revoke: vi.fn(),
        status: vi.fn(),
        materialize: vi.fn(),
    };
}

const manualAuthenticationMode = Object.freeze({
    id: 'manual',
    kind: 'manual' as const,
    outcomeReconciliation: 'none' as const,
    fields: [{
        id: 'token',
        title: 'Token',
        schema: { type: 'string' as const },
        secret: true,
    }],
});

const declaredAccount = Object.freeze({
    id: 'forge',
    title: 'Forge account',
    authentication: {
        defaultModeId: 'manual',
        modes: [
            manualAuthenticationMode,
            {
                id: 'device',
                kind: 'oauthDeviceCode' as const,
                outcomeReconciliation: 'providerCheck' as const,
            },
        ],
    },
} satisfies PluginConnectedAccountDescriptorContributionV2);

function scope(
    declaration: PluginConnectedAccountDescriptorContributionV2 = declaredAccount,
) {
    return createPluginRegistrationScope({
        pluginId: 'acme.accounts',
        target: { realm: 'daemon' },
        rights: [{
            family: 'connectedAccountDescriptors',
            localId: 'forge',
            target: { realm: 'daemon' },
            connectedAccountDescriptorDeclaration: declaration,
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
        expect(registration?.value).toMatchObject({
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual',
                        complete: expect.any(Function),
                    },
                    device: {
                        kind: 'oauthDeviceCode',
                        begin: expect.any(Function),
                        poll: expect.any(Function),
                        cancel: expect.any(Function),
                        reconcile: expect.any(Function),
                    },
                },
            },
            refresh: expect.any(Function),
            revoke: expect.any(Function),
            status: expect.any(Function),
            materialize: expect.any(Function),
        });
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
        retired.api.connectedAccounts.register('forge', {
            authentication: {
                kind: 'manual',
                complete: vi.fn(),
            },
            ...commonRuntime(),
        } as unknown as PluginConnectedAccountRuntime);
        expect(() => retired.commit()).toThrow(/invalid 'connectedAccountDescriptors\/forge' runtime/i);

        const malformed = scope();
        malformed.api.connectedAccounts.register('forge', {
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
        } as unknown as PluginConnectedAccountRuntime);
        expect(() => malformed.commit()).toThrow(/invalid 'connectedAccountDescriptors\/forge' runtime/i);

        const invalidModeId = scope();
        invalidModeId.api.connectedAccounts.register('forge', {
            authentication: {
                modes: {
                    ['__proto__']: {
                        kind: 'manual',
                        complete: vi.fn(),
                    },
                },
            },
            ...commonRuntime(),
        } as unknown as PluginConnectedAccountRuntime);
        expect(() => invalidModeId.commit()).toThrow(/invalid 'connectedAccountDescriptors\/forge' runtime/i);
    });

    it('rejects a runtime whose declared provider reconciliation cannot run before publication', () => {
        const registrationScope = scope();
        registrationScope.api.connectedAccounts.register('forge', {
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
                    },
                },
            },
            ...commonRuntime(),
        } satisfies PluginConnectedAccountRuntime);

        expect(() => registrationScope.commit())
            .toThrow(/reconciliation reachability does not match/i);
        expect(registrationScope.registrations()).toEqual([]);
    });

    it('captures class-based account and authentication-mode callbacks', async () => {
        class ManualMode {
            readonly kind = 'manual' as const;
            readonly marker = 'mode-captured';
            readonly unrelated = true;

            async complete() {
                return { marker: this.marker } as never;
            }
        }
        class Runtime {
            readonly marker = 'runtime-captured';
            readonly unrelated = true;
            readonly authentication = { modes: { manual: new ManualMode() } };

            async refresh() { return { marker: this.marker } as never; }
            async revoke() { return { marker: this.marker } as never; }
            async status() { return { marker: this.marker } as never; }
            async materialize() { return { marker: this.marker } as never; }
        }
        const runtime = new Runtime();
        const registrationScope = scope(Object.freeze({
            id: 'forge',
            title: 'Forge account',
            authentication: {
                defaultModeId: 'manual',
                modes: [manualAuthenticationMode],
            },
        }));

        registrationScope.api.connectedAccounts.register(
            'forge',
            runtime as PluginConnectedAccountRuntime,
        );
        (runtime as unknown as { status: () => Promise<unknown> }).status = async () => ({
            marker: 'replacement',
        });

        const [registration] = registrationScope.commit();
        if (registration?.family !== 'connectedAccountDescriptors') {
            throw new Error('Expected a connected-account runtime registration');
        }
        const manual = registration.value.authentication.modes.manual;
        if (!manual || manual.kind !== 'manual') {
            throw new Error('Expected captured manual authentication mode');
        }

        await expect(registration.value.status({} as never)).resolves.toEqual({
            marker: 'replacement',
        });
        await expect(manual.complete(
            {} as never,
            {} as never,
        )).resolves.toEqual({ marker: 'mode-captured' });
        expect(registration.value).not.toHaveProperty('unrelated');
        expect(registration.value.authentication.modes.manual).not.toHaveProperty('unrelated');
    });
});
