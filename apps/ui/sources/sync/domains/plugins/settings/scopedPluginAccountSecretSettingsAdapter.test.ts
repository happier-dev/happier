import {
    applyAccountSettingsSavedSecretMutation,
    resolveAccountSettingsPluginSecret,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    createAccountPluginSecretSettingsAdapter,
    eraseAccountPluginSecretSettingsBindings,
    type AccountPluginSecretSettingsBoundary,
    type AccountPluginSecretSettingsSnapshot,
} from './scopedPluginAccountSecretSettingsAdapter';

const PLUGIN_ID = 'acme.settings';
const FIELD_ID = 'apiToken';
const TARGET = Object.freeze({ kind: 'account' as const, serverIdentityId: 'server-identity-a' });
const FIELDS = Object.freeze([{ key: FIELD_ID, redacted: true }]);

function initialSettings(): Record<string, unknown> {
    return applyAccountSettingsSavedSecretMutation({}, {
        kind: 'replacePluginSecret',
        target: { pluginId: PLUGIN_ID, localId: FIELD_ID },
        expectedSecretId: null,
        expectedSecretUpdatedAt: null,
        secret: {
            id: 'existing-secret',
            name: 'Existing plugin token',
            kind: 'other',
            encryptedValue: { _isSecretValue: true, value: 'old-token-must-not-reach-renderer' },
            createdAt: 1,
            updatedAt: 1,
        },
    }).settings as Record<string, unknown>;
}

function existingSavedSecretSettings(): Record<string, unknown> {
    return applyAccountSettingsSavedSecretMutation({}, {
        kind: 'add',
        secret: {
            id: 'saved-secret-owned-by-user',
            name: 'Existing account token',
            kind: 'other',
            encryptedValue: { _isSecretValue: true, value: 'existing-token-must-not-reach-renderer' },
            createdAt: 1,
            updatedAt: 1,
        },
    }).settings as Record<string, unknown>;
}

describe('Account plugin SavedSecret Settings adapter', () => {
    it('binds and explicitly unbinds an existing SavedSecret without projecting its value or identity', async () => {
        let snapshot: AccountPluginSecretSettingsSnapshot = {
            revision: 5,
            settings: existingSavedSecretSettings(),
        };
        const writeOnce = vi.fn<AccountPluginSecretSettingsBoundary['writeOnce']>(async (input) => {
            expect(input.target).toEqual(TARGET);
            expect(input.expectedRevision).toBe(snapshot.revision);
            snapshot = {
                revision: snapshot.revision + 1,
                settings: input.mutate(snapshot.settings),
            };
            return { status: 'applied', snapshot };
        });
        const adapter = createAccountPluginSecretSettingsAdapter({
            readSnapshot: () => snapshot,
            writeOnce,
        }, {
            createId: () => 'unused-replacement-secret',
            now: () => 10,
        });

        const bound = await adapter.write({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: TARGET,
            fields: FIELDS,
            fieldId: FIELD_ID,
            // The host picker supplies this opaque one-shot intent; the
            // adapter must never add the selected identity to its snapshot.
            mutation: { kind: 'bind', savedSecretId: 'saved-secret-owned-by-user' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        });

        expect(bound).toEqual({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: TARGET,
                revision: { kind: 'account-secret', value: 6 },
                values: {},
                secretStates: { [FIELD_ID]: 'configured' },
            },
        });
        expect(JSON.stringify(bound)).not.toContain('saved-secret-owned-by-user');
        expect(JSON.stringify(bound)).not.toContain('existing-token-must-not-reach-renderer');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: PLUGIN_ID,
            localId: FIELD_ID,
        })).toMatchObject({
            binding: {
                savedSecretId: 'saved-secret-owned-by-user',
                createdForBinding: false,
            },
        });

        const unbound = await adapter.write({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: TARGET,
            fields: FIELDS,
            fieldId: FIELD_ID,
            mutation: { kind: 'unbind' },
            expectedRevision: { kind: 'account-secret', value: 6 },
        });

        expect(unbound).toEqual({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: TARGET,
                revision: { kind: 'account-secret', value: 7 },
                values: {},
                secretStates: { [FIELD_ID]: 'missing' },
            },
        });
        expect(JSON.stringify(unbound)).not.toContain('saved-secret-owned-by-user');
        expect(JSON.stringify(unbound)).not.toContain('existing-token-must-not-reach-renderer');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: PLUGIN_ID,
            localId: FIELD_ID,
        })).toBeNull();
        expect((snapshot.settings.secrets as readonly { id: string }[]).map(({ id }) => id))
            .toEqual(['saved-secret-owned-by-user']);
        expect(writeOnce).toHaveBeenCalledTimes(2);
    });

    it('replaces and clears a declared Account secret through one SavedSecret owner without projecting its value', async () => {
        let snapshot: AccountPluginSecretSettingsSnapshot = {
            revision: 5,
            settings: initialSettings(),
        };
        const writeOnce = vi.fn<AccountPluginSecretSettingsBoundary['writeOnce']>(async (input) => {
            expect(input.target).toEqual(TARGET);
            expect(input.expectedRevision).toBe(snapshot.revision);
            snapshot = {
                revision: snapshot.revision + 1,
                settings: input.mutate(snapshot.settings),
            };
            return { status: 'applied', snapshot };
        });
        const boundary: AccountPluginSecretSettingsBoundary = {
            readSnapshot: ({ target }) => target.serverIdentityId === TARGET.serverIdentityId ? snapshot : null,
            writeOnce,
        };
        const adapter = createAccountPluginSecretSettingsAdapter(boundary, {
            createId: () => 'replacement-secret',
            now: () => 10,
        });

        const read = await adapter.read({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: TARGET,
            fields: FIELDS,
        });
        expect(read).toEqual({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: TARGET,
                revision: { kind: 'account-secret', value: 5 },
                values: {},
                secretStates: { [FIELD_ID]: 'configured' },
            },
        });
        expect(JSON.stringify(read)).not.toContain('old-token-must-not-reach-renderer');

        const replaced = await adapter.write({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: TARGET,
            fields: FIELDS,
            fieldId: FIELD_ID,
            mutation: { kind: 'set', value: 'new-token-must-not-reach-renderer' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        });
        expect(replaced).toEqual({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: TARGET,
                revision: { kind: 'account-secret', value: 6 },
                values: {},
                secretStates: { [FIELD_ID]: 'configured' },
            },
        });
        expect(JSON.stringify(replaced)).not.toContain('new-token-must-not-reach-renderer');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: PLUGIN_ID,
            localId: FIELD_ID,
        })).toMatchObject({
            binding: { savedSecretId: 'replacement-secret' },
            secret: { encryptedValue: { value: 'new-token-must-not-reach-renderer' } },
        });

        const cleared = await adapter.write({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: TARGET,
            fields: FIELDS,
            fieldId: FIELD_ID,
            mutation: { kind: 'delete' },
            expectedRevision: { kind: 'account-secret', value: 6 },
        });
        expect(cleared).toEqual({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: TARGET,
                revision: { kind: 'account-secret', value: 7 },
                values: {},
                secretStates: { [FIELD_ID]: 'missing' },
            },
        });
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: PLUGIN_ID,
            localId: FIELD_ID,
        })).toBeNull();
        expect(writeOnce).toHaveBeenCalledTimes(2);
    });

    it('surfaces a rejected Account Settings CAS as conflict without replaying the secret mutation', async () => {
        const snapshot: AccountPluginSecretSettingsSnapshot = {
            revision: 6,
            settings: initialSettings(),
        };
        const writeOnce = vi.fn<AccountPluginSecretSettingsBoundary['writeOnce']>(async () => ({
            status: 'conflict',
            snapshot,
        }));
        const adapter = createAccountPluginSecretSettingsAdapter({
            readSnapshot: () => ({ revision: 5, settings: initialSettings() }),
            writeOnce,
        }, {
            createId: () => 'replacement-secret',
            now: () => 10,
        });

        await expect(adapter.write({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: TARGET,
            fields: FIELDS,
            fieldId: FIELD_ID,
            mutation: { kind: 'set', value: 'new-token-must-not-reach-renderer' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        })).resolves.toEqual({
            status: 'conflict',
            snapshot: {
                scope: { kind: 'account' },
                target: TARGET,
                revision: { kind: 'account-secret', value: 6 },
                values: {},
                secretStates: { [FIELD_ID]: 'configured' },
            },
        });
        expect(writeOnce).toHaveBeenCalledTimes(1);
    });

    it('keeps explicit Account secret delete and unbind outcomes unknown after the owner-safe readback', async () => {
        const boundExistingSavedSecretSettings = applyAccountSettingsSavedSecretMutation(
            existingSavedSecretSettings(),
            {
                kind: 'bindPluginSecret',
                target: { pluginId: PLUGIN_ID, localId: FIELD_ID },
                expectedSecretId: null,
                expectedSecretUpdatedAt: null,
                secretId: 'saved-secret-owned-by-user',
            },
        ).settings as Record<string, unknown>;

        for (const input of [
            { mutation: { kind: 'delete' as const }, settings: initialSettings() },
            { mutation: { kind: 'unbind' as const }, settings: boundExistingSavedSecretSettings },
        ]) {
            let snapshot: AccountPluginSecretSettingsSnapshot = {
                revision: 5,
                settings: input.settings,
            };
            const writeOnce = vi.fn<AccountPluginSecretSettingsBoundary['writeOnce']>(async (write) => {
                snapshot = {
                    revision: snapshot.revision + 1,
                    settings: write.mutate(snapshot.settings),
                };
                // The Account Settings owner performed its one safe readback,
                // but cannot attribute this current state to the request.
                return { status: 'outcomeUnknown', snapshot };
            });
            const adapter = createAccountPluginSecretSettingsAdapter({
                readSnapshot: () => snapshot,
                writeOnce,
            }, {
                createId: () => 'replacement-secret',
                now: () => 10,
            });

            await expect(adapter.write({
                pluginId: PLUGIN_ID,
                scope: { kind: 'account' },
                target: TARGET,
                fields: FIELDS,
                fieldId: FIELD_ID,
                mutation: input.mutation,
                expectedRevision: { kind: 'account-secret', value: 5 },
            })).resolves.toEqual({
                status: 'outcomeUnknown',
                snapshot: {
                    scope: { kind: 'account' },
                    target: TARGET,
                    revision: { kind: 'account-secret', value: 6 },
                    values: {},
                    secretStates: { [FIELD_ID]: 'missing' },
                },
            });
            expect(writeOnce).toHaveBeenCalledOnce();
        }
    });

    it('erases one plugin through the captured whole-Settings CAS and treats a retry as a completed no-op', async () => {
        let snapshot: AccountPluginSecretSettingsSnapshot = {
            revision: 5,
            settings: initialSettings(),
        };
        const writeOnce = vi.fn<AccountPluginSecretSettingsBoundary['writeOnce']>(async (input) => {
            expect(input.target).toEqual(TARGET);
            expect(input.expectedRevision).toBe(5);
            snapshot = {
                revision: snapshot.revision + 1,
                settings: input.mutate(snapshot.settings),
            };
            return { status: 'applied', snapshot };
        });
        const boundary: AccountPluginSecretSettingsBoundary = {
            readSnapshot: () => snapshot,
            writeOnce,
        };

        const erased = await eraseAccountPluginSecretSettingsBindings({
            boundary,
            target: TARGET,
            pluginId: PLUGIN_ID,
        });

        expect(erased).toEqual({ status: 'completed', changed: true });
        expect(JSON.stringify(erased)).not.toContain('old-token-must-not-reach-renderer');
        expect(resolveAccountSettingsPluginSecret(snapshot.settings, {
            pluginId: PLUGIN_ID,
            localId: FIELD_ID,
        })).toBeNull();
        expect(writeOnce).toHaveBeenCalledTimes(1);

        await expect(eraseAccountPluginSecretSettingsBindings({
            boundary,
            target: TARGET,
            pluginId: PLUGIN_ID,
        })).resolves.toEqual({ status: 'completed', changed: false });
        expect(writeOnce).toHaveBeenCalledTimes(1);
    });

    it('returns the one-shot CAS outcome without retrying conflicts or unavailable writes', async () => {
        const snapshot: AccountPluginSecretSettingsSnapshot = {
            revision: 5,
            settings: initialSettings(),
        };
        const conflict = vi.fn<AccountPluginSecretSettingsBoundary['writeOnce']>(async () => ({
            status: 'conflict',
            snapshot,
        }));

        await expect(eraseAccountPluginSecretSettingsBindings({
            boundary: { readSnapshot: () => snapshot, writeOnce: conflict },
            target: TARGET,
            pluginId: PLUGIN_ID,
        })).resolves.toEqual({ status: 'conflict' });
        expect(conflict).toHaveBeenCalledTimes(1);

        const unavailable = vi.fn<AccountPluginSecretSettingsBoundary['writeOnce']>(async () => ({
            status: 'unavailable',
        }));
        await expect(eraseAccountPluginSecretSettingsBindings({
            boundary: { readSnapshot: () => snapshot, writeOnce: unavailable },
            target: TARGET,
            pluginId: PLUGIN_ID,
        })).resolves.toEqual({ status: 'unavailable' });
        expect(unavailable).toHaveBeenCalledTimes(1);
    });
});
