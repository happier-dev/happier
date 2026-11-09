import { describe, expect, it } from 'vitest';

import { validateHomeSettingsWrite } from './homeSettingsWrite.js';
import { composeServerConfigRegistry, defineServerConfigRegistry } from './serverConfigEntry.js';
import { SERVER_CONFIG_REGISTRY_BASE } from './registry.js';

const REGISTRY = composeServerConfigRegistry(
    defineServerConfigRegistry({
        MAIL_PORT: { type: 'int', bounds: { min: 1, max: 65_535 }, sensitivity: 'plain', apply: 'live', editable: 'home', section: 'email', description: 'Port.' },
        MAIL_PASSWORD: { type: 'string', sensitivity: 'secret', apply: 'live', editable: 'home', section: 'email', description: 'Password.' },
        DATABASE_URL: {
            type: 'string',
            sensitivity: 'secret',
            apply: 'restart',
            editable: 'bootstrap',
            section: 'server',
            description: 'Database.',
            readOnlyReason: 'before_database',
            reason: 'Read before the database opens.',
        },
        CANONICAL_URL: {
            type: 'url',
            sensitivity: 'plain',
            apply: 'restart',
            editable: 'bootstrap',
            section: 'reach',
            description: 'Audience.',
            readOnlyReason: 'invariant',
            reason: 'The sign-in audience.',
        },
        INFERRED_MARKER: { type: 'string', sensitivity: 'plain', apply: 'restart', editable: 'internal', section: 'reach', description: 'Marker.' },
    }),
);

describe('validateHomeSettingsWrite', () => {
    it.each([
        'HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID',
        'HAPPIER_SERVER_STARTUP_RECEIPT_PATH',
        'HAPPIER_SERVER_STARTUP_RECEIPT_NONCE',
        'HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY',
        'HAPPIER_RELEASE_SOURCE_SHA',
        'HAPPIER_SERVER_FLAVOR',
        'HAPPIER_HOME_IROH_HOLDER',
    ])('refuses Home writes and clears for the producer-owned runtime fact %s', key => {
        for (const value of ['stored-override', null]) {
            expect(validateHomeSettingsWrite(SERVER_CONFIG_REGISTRY_BASE, { values: { [key]: value } })).toEqual({
                ok: false, error: 'home_settings_invalid', key, reason: 'not_home_editable',
            });
        }
    });

    it.each(['HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS', 'HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS'])(
        'refuses the retired relay deadline override %s', key => {
            expect(validateHomeSettingsWrite(SERVER_CONFIG_REGISTRY_BASE, { values: { [key]: 120_000 } })).toEqual({
                ok: false, error: 'home_settings_invalid', key, reason: 'unknown_key',
            });
        },
    );

    it('accepts Home-editable values and secrets, normalizing values and clears', () => {
        expect(
            validateHomeSettingsWrite(REGISTRY, {
                values: { MAIL_PORT: 2525 },
                secrets: { MAIL_PASSWORD: { replace: ' hunter2 ' } },
            }),
        ).toEqual({ ok: true, values: { MAIL_PORT: 2525 }, secrets: { MAIL_PASSWORD: 'hunter2' } });
        expect(validateHomeSettingsWrite(REGISTRY, { values: { MAIL_PORT: null }, secrets: { MAIL_PASSWORD: { clear: true } } })).toEqual({
            ok: true,
            values: { MAIL_PORT: null },
            secrets: { MAIL_PASSWORD: null },
        });
    });

    it('refuses unknown, non-Home, out-of-bounds and misrouted secret keys with home_settings_invalid', () => {
        const refusal = (key: string, reason: string) => ({ ok: false, error: 'home_settings_invalid', key, reason });
        expect(validateHomeSettingsWrite(REGISTRY, { values: { NOT_DECLARED: 'x' } })).toEqual(refusal('NOT_DECLARED', 'unknown_key'));
        expect(validateHomeSettingsWrite(REGISTRY, { values: { toString: 'x' } })).toEqual(refusal('toString', 'unknown_key'));
        expect(validateHomeSettingsWrite(REGISTRY, { values: {}, secrets: { DATABASE_URL: { replace: 'postgres://x' } } })).toEqual(
            refusal('DATABASE_URL', 'not_home_editable'),
        );
        expect(validateHomeSettingsWrite(REGISTRY, { values: { CANONICAL_URL: 'https://a.example' } })).toEqual(
            refusal('CANONICAL_URL', 'not_home_editable'),
        );
        expect(validateHomeSettingsWrite(REGISTRY, { values: { INFERRED_MARKER: '1' } })).toEqual(refusal('INFERRED_MARKER', 'not_home_editable'));
        expect(validateHomeSettingsWrite(REGISTRY, { values: { MAIL_PORT: 70_000 } })).toEqual(refusal('MAIL_PORT', 'out_of_bounds'));
        expect(validateHomeSettingsWrite(REGISTRY, { values: { MAIL_PASSWORD: 'hunter2' } })).toEqual(refusal('MAIL_PASSWORD', 'secret_in_values'));
        expect(validateHomeSettingsWrite(REGISTRY, { values: {}, secrets: { MAIL_PORT: { replace: '25' } } })).toEqual(refusal('MAIL_PORT', 'not_secret'));
    });
});
