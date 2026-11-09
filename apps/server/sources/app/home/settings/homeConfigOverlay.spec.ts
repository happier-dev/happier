import { HomeSettingsProjectionV1Schema, composeServerConfigRegistry, defineServerConfigRegistry, readServerConfig, serializeServerConfigValue, validateHomeSettingsWrite, validateServerConfigValue } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { SERVER_CONFIG_REGISTRY } from '@/config/serverConfigRegistry';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { resolveDefaultAuthOffboardingEnabled } from '@/app/auth/authPolicy';
import { normalizePublicReleaseRingId, PUBLIC_RELEASE_RING_IDS } from '@happier-dev/release-runtime/releaseRings';

import { buildHomeConfigEnv, projectHomeSettings, readHomeConfigFlag, resolveHomeSetting } from './homeConfigOverlay';
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
    it('reads a live plain flag without materializing unrelated environment entries', () => {
        const env = {
            get UNRELATED_SECRET(): string { throw new Error('Unrelated environment entry was materialized'); },
        };
        expect(readHomeConfigFlag(env, { HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: true },
            SERVER_CONFIG.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS)).toBe(true);
    });

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
    it.each([
        'HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID',
        'HAPPIER_SERVER_STARTUP_RECEIPT_PATH',
        'HAPPIER_SERVER_STARTUP_RECEIPT_NONCE',
        'HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY',
        'HAPPIER_RELEASE_SOURCE_SHA',
        'HAPPIER_SERVER_FLAVOR',
        'HAPPIER_HOME_IROH_HOLDER',
    ])('excludes the runtime fact %s from the editor and retained startup overrides', key => {
        const persisted = { [key]: 'stored-override' };
        const start = (env: Record<string, string>) => buildStartupHomeEnv({
            env, stored: { values: persisted, secrets: {} }, registry: SERVER_CONFIG_REGISTRY,
            now: new Date('2026-10-28T00:00:00Z'),
        });
        const producerValue = key === 'HAPPIER_SERVER_FLAVOR' ? 'light' : 'producer-value';
        const startup = start({ [key]: producerValue });
        expect(startup.env[key]).toBe(producerValue);
        expect(startup.snapshot.applied).not.toContain(key);
        expect(start({}).env[key]).toBeUndefined();
        expect(projectHomeSettings({ env: startup.deploymentEnv, persisted, persistedSecretKeys: [], startup }).some(row => row.key === key)).toBe(false);
    });

    it.each([
        ['light', 'local', 'sqlite', 100, 1600, 0],
        ['full', 's3', 'postgres', 200, 5000, 0.25],
    ] as const)('projects the %s runtime defaults in declarations, values and applied restart facts', (flavor, backend, provider, delay, maxDelay, jitter) => {
        const env = { HAPPIER_SERVER_FLAVOR: flavor };
        const startup = buildStartupHomeEnv({ env, stored: { values: {}, secrets: {} }, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) });
        const rows = projectHomeSettings({ env, persisted: {}, persistedSecretKeys: [], startup });
        const expected = {
            HAPPIER_FILES_BACKEND: backend,
            HAPPIER_DB_PROVIDER: provider,
            HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: delay,
            HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: maxDelay,
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: jitter,
            SENTRY_ENVIRONMENT: `production:${flavor}`,
        };
        for (const [key, value] of Object.entries(expected)) {
            expect(rows.find((row) => row.key === key), key).toMatchObject({
                value, source: 'default', fixed: false, declaration: { default: value },
                applied: { value, pending: false },
            });
        }
        expect(HomeSettingsProjectionV1Schema.safeParse({ revision: 0, startedAt: null, entries: rows }).success).toBe(true);
    });

    it('resolves dependent defaults from Home values without turning them into deployment locks', () => {
        const env = { HAPPIER_SERVER_FLAVOR: 'full', HAPPIER_DB_PROVIDER: 'sqlite', HAPPIER_SOCKET_REDIS_ADAPTER: '1', NODE_ENV: 'preview' };
        const persisted = { HAPPIER_AUTH_EMAIL_SMTP_SECURE: true, AUTH_GITHUB_ALLOWED_ORGS: ['acme'], AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'oauth_user_token' };
        const rows = projectHomeSettings({ env, persisted, persistedSecretKeys: [] });
        for (const [key, value] of Object.entries({
            HAPPIER_SOCKET_ADAPTER: 'redis-streams',
            HAPPIER_AUTH_EMAIL_SMTP_PORT: 465,
            HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 100,
            AUTH_OFFBOARDING_ENABLED: true,
            GITHUB_STORE_ACCESS_TOKEN: true,
            SENTRY_ENVIRONMENT: 'preview:full',
        })) {
            expect(rows.find((row) => row.key === key), key).toMatchObject({ value, source: 'default', fixed: false, declaration: { default: value } });
        }
        const source = rows.find((row) => row.key === 'AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE');
        expect(source).toMatchObject({ value: 'oauth_user_token', source: 'home', declaration: { default: 'github_app' } });
    });

    it('preserves explicit and persisted backend precedence while reporting the runtime fallback', () => {
        const env = { HAPPIER_SERVER_FLAVOR: 'full', HAPPY_FILES_BACKEND: ' DiSk ' };
        const startup = buildStartupHomeEnv({ env, stored: { values: {}, secrets: {} }, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) });
        const row = projectHomeSettings({ env, persisted: {}, persistedSecretKeys: [], startup }).find((entry) => entry.key === 'HAPPIER_FILES_BACKEND');
        expect(row).toMatchObject({ value: 'local', source: 'deployment', fixed: true, declaration: { default: 's3' }, applied: { value: 'local', pending: false } });
        const pending = projectHomeSettings({ env: { HAPPIER_SERVER_FLAVOR: 'full' }, persisted: { HAPPIER_FILES_BACKEND: 'local' }, persistedSecretKeys: [], startup: buildStartupHomeEnv({ env: { HAPPIER_SERVER_FLAVOR: 'full' }, stored: { values: {}, secrets: {} }, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) }) }).find((entry) => entry.key === 'HAPPIER_FILES_BACKEND');
        expect(pending).toMatchObject({ value: 'local', source: 'home', declaration: { default: 's3' }, applied: { value: 's3', pending: true } });
    });

    it('keeps a malformed explicit socket adapter on the startup fallback instead of enabling the legacy flag', () => {
        const env = { HAPPIER_SERVER_FLAVOR: 'full', HAPPIER_SOCKET_ADAPTER: 'invalid', HAPPY_SOCKET_REDIS_ADAPTER: 'true' };
        const row = projectHomeSettings({ env, persisted: {}, persistedSecretKeys: [] }).find((entry) => entry.key === 'HAPPIER_SOCKET_ADAPTER');
        expect(row).toMatchObject({ value: 'memory', source: 'deployment', fixed: true, declaration: { default: 'redis-streams' } });
    });

    it('projects local startup paths and SQLite budgets through their existing resolvers', () => {
        const env = { HAPPIER_SERVER_FLAVOR: 'light', HAPPIER_SERVER_LIGHT_DATA_DIR: '/home-defaults-fixture', PORT: '4242', HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '42000' };
        const rows = projectHomeSettings({ env, persisted: {}, persistedSecretKeys: [] });
        for (const [key, value] of Object.entries({
            HAPPIER_SERVER_LIGHT_FILES_DIR: join(env.HAPPIER_SERVER_LIGHT_DATA_DIR, 'files'),
            HAPPIER_SERVER_LIGHT_DB_DIR: join(env.HAPPIER_SERVER_LIGHT_DATA_DIR, 'pglite'),
            PUBLIC_URL: 'http://localhost:4242',
            HAPPIER_DB_TX_TIMEOUT_MS: 42000,
            HAPPIER_DB_TX_MAX_WAIT_MS: 42000,
            HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 168100,
        })) {
            expect.soft(rows.find((row) => row.key === key), key).toMatchObject({ value, source: 'default', fixed: false, declaration: { default: value } });
        }
        const full = projectHomeSettings({ env: { HAPPIER_SERVER_FLAVOR: 'full' }, persisted: {}, persistedSecretKeys: [] });
        expect(full.find((row) => row.key === 'HAPPIER_SERVER_LIGHT_FILES_DIR')).toMatchObject({ value: null, source: 'default' });
    });

    it('uses opened restart configuration for dependent defaults while keeping the secret write-only', () => {
        const providerConfig = JSON.stringify([{ id: 'corp', type: 'oidc', displayName: 'Company', issuer: 'https://issuer.example.test', clientId: 'fixture', clientAuthenticationMethod: 'client_secret_post', clientSecret: 'fixture-only', redirectUrl: 'https://home.example.test/oauth/callback', scopes: 'openid profile email', allow: { groupsAny: ['engineering'] }, storeRefreshToken: true }]);
        expect(resolveDefaultAuthOffboardingEnabled({ AUTH_PROVIDERS_CONFIG_JSON: providerConfig })).toBe(true);
        const input = { env: {}, persisted: {}, persistedSecretKeys: ['AUTH_PROVIDERS_CONFIG_JSON'], persistedRestartSecrets: { AUTH_PROVIDERS_CONFIG_JSON: providerConfig } };
        const rows = projectHomeSettings({ ...input, runtimeEnv: { AUTH_PROVIDERS_CONFIG_JSON: providerConfig } });
        expect(rows.find((row) => row.key === 'AUTH_OFFBOARDING_ENABLED')).toMatchObject({ value: true, declaration: { default: true } });
        const secret = rows.find((row) => row.key === 'AUTH_PROVIDERS_CONFIG_JSON');
        expect(secret).toMatchObject({ value: null, secretSet: true });
        expect(secret?.declaration.default).toBeUndefined();
        expect(JSON.stringify(rows).includes('fixture-only')).toBe(false);
        const pending = projectHomeSettings({ ...input, runtimeEnv: {} });
        expect(pending.find((row) => row.key === 'AUTH_OFFBOARDING_ENABLED')).toMatchObject({ value: false, declaration: { default: false } });
    });

    it('reports the running defaults rather than prospective restart dependencies', () => {
        const env = { HAPPIER_SERVER_FLAVOR: 'light' };
        const runtimeEnv = { ...env, PORT: '4242', PUBLIC_URL: 'http://localhost:3005' };
        const persisted = { PORT: 4242, HAPPIER_SOCKET_REDIS_ADAPTER: true };
        const startup = buildStartupHomeEnv({ env, stored: { values: { PORT: 4242 }, secrets: {} }, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) });
        const rows = projectHomeSettings({ env, runtimeEnv, persisted, persistedSecretKeys: [], startup });
        expect(rows.find((row) => row.key === 'PUBLIC_URL')).toMatchObject({ value: 'http://localhost:3005', declaration: { default: 'http://localhost:3005' }, applied: { value: 'http://localhost:3005', pending: false } });
        expect(rows.find((row) => row.key === 'HAPPIER_SOCKET_ADAPTER')).toMatchObject({ value: 'memory', declaration: { default: 'memory' }, applied: { value: 'memory', pending: false } });
        expect(rows.find((row) => row.key === 'HAPPIER_SOCKET_REDIS_ADAPTER')).toMatchObject({ value: true, source: 'home', applied: { value: false, pending: true } });
    });

    it('projects the complete server registry through the strict settings wire contract', () => {
        const entries = projectHomeSettings({ registry: SERVER_CONFIG_REGISTRY, env: {}, persisted: {}, persistedSecretKeys: [] });
        const projection = { revision: 0, startedAt: null, entries };
        expect(HomeSettingsProjectionV1Schema.parse(projection)).toEqual(projection);
        const displayName = entries.find((entry) => entry.key === 'HAPPIER_HOME_DISPLAY_NAME');
        expect(displayName?.declaration?.bounds).toEqual(SERVER_CONFIG_REGISTRY.HAPPIER_HOME_DISPLAY_NAME.bounds);
        expect(entries.find((entry) => entry.key === 'S3_REGION')?.declaration)
            .toMatchObject({ appliesWhen: { key: 'HAPPIER_FILES_BACKEND', values: ['s3'] } });
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
    it('declares every closed domain in the composed registry and rejects free-text choices', () => {
        const domains: Readonly<Record<string, readonly string[]>> = {
            HAPPIER_FILES_BACKEND: ['local', 's3'],
            HAPPIER_SOCKET_ADAPTER: ['memory', 'redis-streams'],
            HAPPIER_FEATURE_POLICY_ENV: ['production', 'preview'],
            HAPPIER_PUBLIC_RELEASE_CHANNEL: PUBLIC_RELEASE_RING_IDS,
            HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: ['default', 'ip-only', 'user-or-ip'],
            HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: ['default', 'ip-only', 'user-or-ip'],
        };
        for (const entry of Object.values(SERVER_CONFIG_REGISTRY)) {
            const domain = domains[entry.key];
            if (domain) {
                expect(entry.type, entry.key).toBe('enum');
                expect(entry.bounds?.values, entry.key).toEqual(domain);
            }
            if (entry.type !== 'enum') continue;
            for (const value of entry.bounds?.values ?? []) {
                expect(validateServerConfigValue(entry, value), entry.key).toEqual({ ok: true, value });
                expect(readServerConfig({ [entry.key]: value }, entry), entry.key).toBe(value);
            }
            expect(validateServerConfigValue(entry, 'not-a-config-choice'), entry.key).toEqual({ ok: false, reason: 'out_of_bounds' });
        }
    });

    it('opens legacy stored values as canonical choices/booleans and applies them at startup', () => {
        const legacy = {
            HAPPIER_FILES_BACKEND: ' DiSk ',
            HAPPIER_SOCKET_ADAPTER: 'redis_streams',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'ip_only',
            HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'userorip',
            DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'false',
        };
        const expected = {
            HAPPIER_FILES_BACKEND: 'local',
            HAPPIER_SOCKET_ADAPTER: 'redis-streams',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'publicdev',
            HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'ip-only',
            HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'user-or-ip',
            DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: true,
        };
        const startup = buildStartupHomeEnv({ env: {}, stored: { values: legacy, secrets: {} }, registry: SERVER_CONFIG_REGISTRY, now: new Date(0) });
        expect(startup.snapshot.ignored).toEqual({});
        for (const [key, value] of Object.entries(expected)) {
            const entry = SERVER_CONFIG_REGISTRY[key];
            expect(resolveHomeSetting(entry, {}, legacy), key).toEqual({ value, source: 'home', fixed: false });
            expect(readServerConfig(startup.env, entry), key).toBe(value);
            expect(startup.env[key], key).toBe(serializeServerConfigValue(entry, value));
        }
        for (const raw of ['production', 'prod', 'public-dev', 'public_dev', ' DEV ']) {
            const entry = SERVER_CONFIG_REGISTRY.HAPPIER_PUBLIC_RELEASE_CHANNEL;
            expect(readServerConfig({ [entry.key]: raw }, entry)).toBe(normalizePublicReleaseRingId(raw));
        }
        for (const key of ['HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY', 'HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY']) {
            const entry = SERVER_CONFIG_REGISTRY[key];
            for (const raw of ['ip', 'ip_only', 'IP-ONLY']) {
                expect(readServerConfig({ [key]: raw }, entry)).toBe('ip-only');
            }
            for (const raw of ['user', 'user_or_ip', 'userorip', ' USER-OR-IP ']) {
                expect(readServerConfig({ [key]: raw }, entry)).toBe('user-or-ip');
            }
        }
        expect(validateHomeSettingsWrite(SERVER_CONFIG_REGISTRY, { values: expected })).toEqual({ ok: true, values: expected, secrets: {} });
        expect(validateHomeSettingsWrite(SERVER_CONFIG_REGISTRY, { values: { DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'false' } })).toMatchObject({
            ok: false, key: 'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING', reason: 'invalid_type',
        });
    });

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
    if (entry.key === 'HAPPIER_PUBLIC_PROFILE_REPORT_URL') return 'mailto:operator@home.example.test';
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
