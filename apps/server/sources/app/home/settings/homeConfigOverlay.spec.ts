import { HomeSettingsProjectionV1Schema, composeServerConfigRegistry, defineServerConfigRegistry, readServerConfig, serializeServerConfigValue, validateServerConfigValue } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { SERVER_CONFIG_REGISTRY } from '@/config/serverConfigRegistry';

import { buildHomeConfigEnv, projectHomeSettings, resolveHomeSetting } from './homeConfigOverlay';
import { readHomeConfigValueSource } from './homeConfigProvenance';
import { buildStartupHomeEnv } from './startupHomeEnv';

const CONFIG = defineServerConfigRegistry({
    MAIL_HOST: { type: 'string', sensitivity: 'plain', apply: 'live', editable: 'home', section: 'email', aliases: ['LEGACY_MAIL_HOST'], description: 'Host.' },
    MAIL_PORT: { type: 'int', default: 587, bounds: { min: 1, max: 65_535 }, sensitivity: 'plain', apply: 'live', editable: 'home', section: 'email', description: 'Port.' },
    MAIL_PASSWORD: { type: 'string', sensitivity: 'secret', apply: 'live', editable: 'home', section: 'email', description: 'Password.' },
    DATABASE_URL: { type: 'string', sensitivity: 'secret', apply: 'restart', editable: 'bootstrap', section: 'server', description: 'Database.', readOnlyReason: 'before_database', reason: 'Read before the database opens.' },
    DATA_DIR: { type: 'string', default: '/data', sensitivity: 'plain', apply: 'restart', editable: 'bootstrap', section: 'server', description: 'Data directory.', readOnlyReason: 'before_database', reason: 'Read before the database opens.' },
});
const REGISTRY = composeServerConfigRegistry(CONFIG);

describe('resolveHomeSetting (explicit deployment env → persisted Home setting → default)', () => {
    it('lets an explicitly set env value (or alias) win and marks it fixed, even over a persisted value', () => {
        expect(resolveHomeSetting(CONFIG.MAIL_PORT, { MAIL_PORT: '25' }, { MAIL_PORT: 2525 })).toEqual({ value: 25, source: 'deployment', fixed: true });
        expect(resolveHomeSetting(CONFIG.MAIL_HOST, { LEGACY_MAIL_HOST: 'smtp.env' }, { MAIL_HOST: 'smtp.home' })).toEqual({
            value: 'smtp.env',
            source: 'deployment',
            fixed: true,
        });
    });

    it('uses the persisted value when env leaves the key unset, and the default when neither sets it', () => {
        expect(resolveHomeSetting(CONFIG.MAIL_PORT, { MAIL_PORT: '  ' }, { MAIL_PORT: 2525 })).toEqual({ value: 2525, source: 'home', fixed: false });
        expect(resolveHomeSetting(CONFIG.MAIL_PORT, {}, {})).toEqual({ value: 587, source: 'default', fixed: false });
        expect(resolveHomeSetting(CONFIG.MAIL_HOST, {}, {})).toEqual({ value: null, source: 'default', fixed: false });
    });

    it('never applies a persisted value to a key that is not Home-editable, or one its entry no longer accepts', () => {
        expect(resolveHomeSetting(CONFIG.DATA_DIR, {}, { DATA_DIR: '/elsewhere' })).toEqual({ value: '/data', source: 'default', fixed: false });
        expect(resolveHomeSetting(CONFIG.MAIL_PORT, {}, { MAIL_PORT: 70_000 })).toEqual({ value: 587, source: 'default', fixed: false });
    });
});

describe('buildHomeConfigEnv', () => {
    it('fills only keys the deployment env leaves unset, so unchanged env readers see persisted values', () => {
        const env = { MAIL_PORT: '25', UNRELATED: 'kept' };
        const overlay = buildHomeConfigEnv(env, { MAIL_PORT: 2525, MAIL_HOST: 'smtp.home', DATA_DIR: '/elsewhere', NOT_DECLARED: 'x' }, REGISTRY);
        // String keys only: the overlay also carries a symbol-keyed provenance stamp (homeConfigProvenance).
        expect(Object.fromEntries(Object.entries(overlay))).toEqual({ MAIL_PORT: '25', UNRELATED: 'kept', MAIL_HOST: 'smtp.home' });
        expect(env).toEqual({ MAIL_PORT: '25', UNRELATED: 'kept' });
    });

    it('fills an inferred value last: env, then the persisted value, then inference (I2)', () => {
        const inferred = { MAIL_HOST: 'smtp.inferred' };
        expect(buildHomeConfigEnv({ MAIL_HOST: 'smtp.env' }, { MAIL_HOST: 'smtp.home' }, REGISTRY, {}, inferred).MAIL_HOST).toBe('smtp.env');
        expect(buildHomeConfigEnv({}, { MAIL_HOST: 'smtp.home' }, REGISTRY, {}, inferred).MAIL_HOST).toBe('smtp.home');
        const overlay = buildHomeConfigEnv({}, {}, REGISTRY, {}, inferred);
        expect(overlay.MAIL_HOST).toBe('smtp.inferred');
        expect(readHomeConfigValueSource(overlay, 'MAIL_HOST')).toBe('inferred');
        expect(readHomeConfigValueSource(buildHomeConfigEnv({}, { MAIL_HOST: 'smtp.home' }, REGISTRY), 'MAIL_HOST')).toBe('home');
        expect(readHomeConfigValueSource({ MAIL_HOST: 'smtp.env' }, 'MAIL_HOST')).toBe('deployment');
        expect(readHomeConfigValueSource({}, 'MAIL_HOST')).toBeNull();
    });

    it('returns the env itself when nothing is persisted', () => {
        const env = { MAIL_PORT: '25' };
        expect(buildHomeConfigEnv(env, {}, REGISTRY)).toBe(env);
    });
});

describe('projectHomeSettings', () => {
    it('projects the complete server registry through the strict settings wire contract', () => {
        const entries = projectHomeSettings({ registry: SERVER_CONFIG_REGISTRY, env: {}, persisted: {}, persistedSecretKeys: [] });
        const projection = { revision: 0, startedAt: null, entries };
        expect(HomeSettingsProjectionV1Schema.parse(projection)).toEqual(projection);
        const displayName = entries.find((entry) => entry.key === 'HAPPIER_HOME_DISPLAY_NAME');
        expect(displayName?.declaration?.bounds).toEqual(SERVER_CONFIG_REGISTRY.HAPPIER_HOME_DISPLAY_NAME.bounds);
    });

    it('never carries a secret value, only whether one is set', () => {
        const projection = projectHomeSettings({
            registry: REGISTRY,
            env: { DATABASE_URL: 'postgres://user:pw@db/happier' },
            persisted: { MAIL_HOST: 'smtp.home' },
            persistedSecretKeys: ['MAIL_PASSWORD'],
        });
        const byKey = Object.fromEntries(projection.map((entry) => [entry.key, entry]));
        expect(byKey.DATABASE_URL).toEqual({ key: 'DATABASE_URL', value: null, source: 'deployment', fixed: true, editable: 'bootstrap', apply: 'restart', readOnlyReason: 'Read before the database opens.', secretSet: true, declaration: { type: 'string', section: 'server', readOnlyReason: 'before_database' } });
        expect(byKey.MAIL_PASSWORD).toEqual({ key: 'MAIL_PASSWORD', value: null, source: 'home', fixed: false, editable: 'home', apply: 'live', secretSet: true, declaration: { type: 'string', section: 'email' } });
        expect(byKey.MAIL_HOST).toEqual({ key: 'MAIL_HOST', value: 'smtp.home', source: 'home', fixed: false, editable: 'home', apply: 'live', declaration: { type: 'string', section: 'email' } });
        expect(JSON.stringify(projection)).not.toContain('pw@db');
    });
});

describe('the server configuration registry', () => {
    it('round-trips every Home-editable entry into its reader (write → live or startup overlay → read → equal)', () => {
        const homeEntries = Object.values(SERVER_CONFIG_REGISTRY).filter((entry) => entry.editable === 'home');
        expect(homeEntries.some((entry) => entry.apply === 'live')).toBe(true);
        expect(homeEntries.some((entry) => entry.apply === 'restart')).toBe(true);
        for (const entry of homeEntries) {
            const validated = validateServerConfigValue(entry, sampleValue(entry));
            expect(validated, entry.key).toMatchObject({ ok: true });
            if (!validated.ok) continue;
            const secret = entry.sensitivity === 'secret';
            // Live secrets are read per send from the sealed column (U1), not through an env overlay.
            if (secret && entry.apply === 'live') continue;
            const stored = { values: secret ? {} : { [entry.key]: validated.value }, secrets: secret ? { [entry.key]: serializeServerConfigValue(entry, validated.value) } : {} };
            const overlay = entry.apply === 'live' && !secret
                ? buildHomeConfigEnv({}, stored.values, SERVER_CONFIG_REGISTRY)
                : buildStartupHomeEnv({ env: {}, stored, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) }).env;
            expect(overlay[entry.key], entry.key).toBe(serializeServerConfigValue(entry, validated.value));
            expect(readServerConfig(overlay, entry), entry.key).toEqual(validated.value);
        }
    });

    it('never lets the request overlay change a restart key mid-process', () => {
        const restart = Object.values(SERVER_CONFIG_REGISTRY).find((entry) => entry.editable === 'home' && entry.apply === 'restart' && entry.sensitivity === 'plain');
        expect(restart).toBeDefined();
        const env = {};
        expect(buildHomeConfigEnv(env, { [restart!.key]: sampleValue(restart!) }, SERVER_CONFIG_REGISTRY)).toBe(env);
    });

    it('declares a default that its own entry accepts', () => {
        for (const entry of Object.values(SERVER_CONFIG_REGISTRY)) {
            if (entry.default === undefined) continue;
            if (entry.type === 'string' && entry.default === '') continue;
            expect(validateServerConfigValue(entry, entry.default), entry.key).toMatchObject({ ok: true });
        }
    });
});

/** A valid, non-default value for an entry, so a reader that ignored the overlay would fail. */
function sampleValue(entry: (typeof SERVER_CONFIG_REGISTRY)[string]): unknown {
    switch (entry.type) {
        case 'boolean':
            return entry.default !== true;
        case 'int':
        case 'float': {
            const min = entry.bounds?.min ?? 1;
            const max = entry.bounds?.max ?? min + 1000;
            const candidate = entry.default === max ? min : max;
            return entry.type === 'int' ? Math.trunc(candidate) : candidate;
        }
        case 'enum': {
            const values = entry.bounds?.values ?? [];
            return values.find((value) => value !== entry.default) ?? values[0];
        }
        case 'url':
            return 'https://home.example.test/path';
        case 'email':
            return 'owner@home.example.test';
        case 'list':
            return entry.bounds?.values ? [...entry.bounds.values] : ['https://a.example.test', 'https://b.example.test'];
        case 'json':
            return { sample: true };
        default:
            return 'home-set value';
    }
}
