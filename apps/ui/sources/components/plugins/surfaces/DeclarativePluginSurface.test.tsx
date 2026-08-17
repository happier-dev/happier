import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoundPluginSurfaceController } from './boundPluginSurfaceController';
import type {
    ScopedPluginSettingsAdapter,
    ScopedPluginSettingsReadResult,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const accountSecretSettingsBoundary = vi.hoisted(() => ({
    read: vi.fn<ScopedPluginSettingsAdapter['read']>(),
    write: vi.fn<ScopedPluginSettingsAdapter['write']>(),
}));

const ordinarySettingsBoundary = vi.hoisted(() => ({
    read: vi.fn<ScopedPluginSettingsAdapter['read']>(),
    write: vi.fn<ScopedPluginSettingsAdapter['write']>(),
}));

vi.mock('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime')>();
    return {
        ...original,
        // Account SavedSecret persistence is a real external-state boundary.
        // The projection, renderer, currentness, and mutation path stay real.
        scopedPluginAccountSecretSettingsAdapter: Object.freeze({
            read: (...args: Parameters<typeof original.scopedPluginAccountSecretSettingsAdapter.read>) => (
                accountSecretSettingsBoundary.read(...args)
            ),
            write: (...args: Parameters<typeof original.scopedPluginAccountSecretSettingsAdapter.write>) => (
                accountSecretSettingsBoundary.write(...args)
            ),
        }),
        scopedPluginSettingsAdapter: Object.freeze({
            read: (...args: Parameters<typeof original.scopedPluginSettingsAdapter.read>) => (
                ordinarySettingsBoundary.read(...args)
            ),
            write: (...args: Parameters<typeof original.scopedPluginSettingsAdapter.write>) => (
                ordinarySettingsBoundary.write(...args)
            ),
        }),
    };
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => Object.freeze({
        serverId: 'account-secret-surface',
        serverUrl: 'https://account-secret-surface',
        generation: 1,
    }),
}));

import { DeclarativePluginSurface } from './DeclarativePluginSurface';
import { renderScreen } from '@/dev/testkit';
import {
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

const ACCOUNT_TARGET = Object.freeze({
    kind: 'account' as const,
    serverIdentityId: 'srv_account_secret_surface',
});

function readyAccountSecret(input: Readonly<{
    revision: number;
    secretState: 'configured' | 'missing';
}>): Extract<ScopedPluginSettingsReadResult, { status: 'ready' }> {
    return {
        status: 'ready',
        snapshot: {
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            revision: { kind: 'account-secret', value: input.revision },
            values: {},
            secretStates: { token: input.secretState },
        },
    };
}

function createAccountLifetime(): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'account-secret-surface', accountId: 'account-secret-test' }),
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

const model = Object.freeze({
    visible: true,
    identity: Object.freeze({
        pluginId: 'acme.account-secret',
        localId: 'settings',
        qualifiedId: 'acme.account-secret/settings',
        generation: 'generation-account-secret',
    }),
    root: Object.freeze({
        kind: 'group',
        path: 'root',
        children: Object.freeze([Object.freeze({
            kind: 'field',
            path: 'root.children[0]',
            label: 'Account token',
            control: Object.freeze({ kind: 'secret', settingId: 'token' }),
            setting: Object.freeze({
                id: 'token',
                descriptor: Object.freeze({ scope: 'account', secret: true, schema: Object.freeze({ type: 'string' }) }),
            }),
        })]),
    }),
});

const dispatchAction: BoundPluginSurfaceController['dispatchAction'] = async () => null;
const openSurface: BoundPluginSurfaceController['openSurface'] = async () => null;

beforeEach(() => {
    accountSecretSettingsBoundary.read.mockReset();
    accountSecretSettingsBoundary.write.mockReset();
    ordinarySettingsBoundary.read.mockReset();
    ordinarySettingsBoundary.write.mockReset();
    const profile = upsertServerProfile({
        serverUrl: 'https://account-secret-surface',
        name: 'Account secret surface',
    });
    expect(profile.id).toBe('account-secret-surface');
    expect(setServerProfileIdentityForUrl(
        profile.serverUrl,
        ACCOUNT_TARGET.serverIdentityId,
    )).toMatchObject({ serverIdentityId: ACCOUNT_TARGET.serverIdentityId });
});

afterEach(() => {
    accountSecretSettingsBoundary.read.mockReset();
    accountSecretSettingsBoundary.write.mockReset();
    ordinarySettingsBoundary.read.mockReset();
    ordinarySettingsBoundary.write.mockReset();
});

describe('DeclarativePluginSurface Account secrets', () => {
    it('requires an explicit local draft before saving a configured redacted secret, while empty save and delete remain distinct', async () => {
        accountSecretSettingsBoundary.read.mockResolvedValue(readyAccountSecret({
            revision: 5,
            secretState: 'configured',
        }));
        accountSecretSettingsBoundary.write.mockImplementation(async (input) => (
            readyAccountSecret({
                revision: input.expectedRevision.kind === 'account-secret'
                    ? input.expectedRevision.value + 1
                    : 6,
                secretState: input.mutation.kind === 'delete' ? 'missing' : 'configured',
            })
        ));

        const screen = await renderScreen(
            <DeclarativePluginSurface
                pluginId="acme.account-secret"
                model={model}
                interactionEnabled={true}
                daemonInteractionEnabled={false}
                settingsScopesEnabled={{ account: true, daemon: false }}
                dispatchAction={dispatchAction}
                actionAvailable={false}
                openSurface={openSurface}
                openSurfaceAvailable={false}
                authorityGeneration={1}
                accountLifetime={createAccountLifetime()}
            />,
        );
        await vi.waitFor(() => expect(accountSecretSettingsBoundary.read).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.account-secret',
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            fields: [{ key: 'token', redacted: true }],
        })));

        const saveTestId = 'plugin-declarative-field-save:root.children[0]';
        const deleteTestId = 'plugin-declarative-field-delete:root.children[0]';
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('');
        expect(screen.findByTestId(saveTestId)?.props.disabled).toBe(true);
        expect(screen.findByTestId(deleteTestId)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(saveTestId);
        });
        expect(accountSecretSettingsBoundary.write).not.toHaveBeenCalled();

        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', '');
        });
        expect(screen.findByTestId(saveTestId)?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId(saveTestId);
        });
        expect(accountSecretSettingsBoundary.write).toHaveBeenLastCalledWith(expect.objectContaining({
            fieldId: 'token',
            mutation: { kind: 'set', value: '' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        }));

        await act(async () => {
            screen.pressByTestId(deleteTestId);
        });
        expect(accountSecretSettingsBoundary.write).toHaveBeenLastCalledWith(expect.objectContaining({
            fieldId: 'token',
            mutation: { kind: 'delete' },
            expectedRevision: { kind: 'account-secret', value: 6 },
        }));
    });
});

describe('DeclarativePluginSurface ordinary Settings', () => {
    it('keeps a replaced-source draft visible but inert until the replacement source edits it', async () => {
        ordinarySettingsBoundary.read
            .mockResolvedValueOnce({
                status: 'ready',
                snapshot: {
                    scope: { kind: 'account' },
                    target: ACCOUNT_TARGET,
                    revision: { kind: 'account', value: 1 },
                    values: { endpoint: 'Source A' },
                    secretStates: {},
                },
            })
            .mockResolvedValueOnce({
                status: 'ready',
                snapshot: {
                    scope: { kind: 'account' },
                    target: ACCOUNT_TARGET,
                    revision: { kind: 'account', value: 2 },
                    values: { endpoint: 'Source B' },
                    secretStates: {},
                },
            });
        ordinarySettingsBoundary.write.mockResolvedValue({ status: 'unavailable', reason: 'transport' });

        const modelForGeneration = (generation: string) => Object.freeze({
            visible: true,
            identity: Object.freeze({
                pluginId: 'acme.ordinary-settings',
                localId: 'settings',
                qualifiedId: 'acme.ordinary-settings/settings',
                generation,
            }),
            root: Object.freeze({
                kind: 'group',
                path: 'root',
                children: Object.freeze([Object.freeze({
                    kind: 'field',
                    path: 'root.children[0]',
                    label: 'Endpoint',
                    control: Object.freeze({ kind: 'text', settingId: 'endpoint' }),
                    setting: Object.freeze({
                        id: 'endpoint',
                        descriptor: Object.freeze({
                            id: 'endpoint',
                            title: 'Endpoint',
                            target: Object.freeze({ kind: 'plugin' }),
                            scope: 'account',
                            schema: Object.freeze({ type: 'string' }),
                        }),
                    }),
                })]),
            }),
        });
        const accountLifetime = createAccountLifetime();
        const renderModel = (generation: string) => (
            <DeclarativePluginSurface
                pluginId="acme.ordinary-settings"
                model={modelForGeneration(generation)}
                interactionEnabled={true}
                daemonInteractionEnabled={false}
                settingsScopesEnabled={{ account: true, daemon: false }}
                dispatchAction={dispatchAction}
                actionAvailable={false}
                openSurface={openSurface}
                openSurfaceAvailable={false}
                authorityGeneration={1}
                accountLifetime={accountLifetime}
            />
        );

        const screen = await renderScreen(renderModel('source-a'));
        await vi.waitFor(() => expect(ordinarySettingsBoundary.read).toHaveBeenCalledTimes(1));
        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Source A draft');
        });

        await screen.update(renderModel('source-b'));
        await vi.waitFor(() => expect(ordinarySettingsBoundary.read).toHaveBeenCalledTimes(2));
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Source A draft');
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);

        await act(async () => {
            screen.pressByTestId('plugin-declarative-field-save:root.children[0]');
        });
        expect(ordinarySettingsBoundary.write).not.toHaveBeenCalled();

        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Source B draft');
        });
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(false);
    });
});
