import { normalizeDokployTemplateV1 } from '@happier-dev/protocol/registries/formats/dokployTemplateNormalizationV1';
import { buildCatalogAppTemplateBindings } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { prepareDeploymentTemplateInstantiationV1 } from '@happier-dev/deployments';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { DeploymentTemplateSecretProfileV1 } from '@happier-dev/protocol/registries';

import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDeploymentTemplateGeneratedSecretForHost, withDeploymentTemplateGeneratedSecretsForHost } from './generatedSecretForHost';

const cases: ReadonlyArray<Readonly<{ profile: DeploymentTemplateSecretProfileV1; pattern: RegExp; decodedBytes?: number }>> = [
    { profile: { kind: 'hex-characters', parts: ['sb_publishable_', 22, '_', 8] }, pattern: /^sb_publishable_[a-f0-9]{22}_[a-f0-9]{8}$/u },
    { profile: { kind: 'hex-characters', parts: [17] }, pattern: /^[a-f0-9]{17}$/u },
    { profile: { kind: 'base64url-32-bytes' }, pattern: /^[A-Za-z0-9_-]{43}$/u, decodedBytes: 32 },
    { profile: { kind: 'hex-32-bytes' }, pattern: /^[a-f0-9]{64}$/u, decodedBytes: 32 },
    { profile: { kind: 'uuid-v4' }, pattern: /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u },
    { profile: { kind: 'lowercase-username' }, pattern: /^[a-z0-9]+$/u },
    { profile: { kind: 'alphanumeric-characters', characters: 64 }, pattern: /^[A-Za-z0-9]{64}$/u },
    { profile: { kind: 'lowercase-alphanumeric-characters', characters: 33 }, pattern: /^[a-z0-9]{33}$/u },
    { profile: { kind: 'hex-bytes', bytes: 16 }, pattern: /^[a-f0-9]{32}$/u, decodedBytes: 16 },
    { profile: { kind: 'base64-bytes', bytes: 32 }, pattern: /^[A-Za-z0-9+/]{43}=$/u, decodedBytes: 32 },
];

describe('template generated secrets through canonical Saved Secret creation', () => {
    it.each(cases)('saves $profile.kind with its exact encoding and reviewed audience, returning only a binding source', async ({ profile, pattern, decodedBytes }) => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const source = await fixture.inHome(() => createDeploymentTemplateGeneratedSecretForHost({
                name: 'Database password', profile, audience: { teamGrants: ['team-reviewed'] },
                expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials,
            }));
            const created = SharedSavedSecretCreateInputV1Schema.parse(fixture.writes[0]);
            const value = fixture.opened(fixture.writes[0]!)?.value;
            expect(fixture.writes).toHaveLength(1);
            expect(created.displayName).toBe('Database password');
            expect(created.teamGrants).toEqual(['team-reviewed']);
            expect(created.accountGrants).toEqual([]);
            expect(created.groupGrants).toEqual([]);
            expect(value).toMatch(pattern);
            if (typeof value !== 'string') throw new Error('Created secret unavailable');
            if (decodedBytes !== undefined) expect(Buffer.from(value, profile.kind.startsWith('hex') ? 'hex'
                : profile.kind === 'base64url-32-bytes' ? 'base64url' : 'base64')).toHaveLength(decodedBytes);
            expect(source).toEqual({ kind: 'secret', ref: `happier:shared-secret:v1:${created.resourceId}`, resourceRevision: 1 });
            expect(JSON.stringify(source)).not.toContain(value);
        } finally { await fixture.close(); }
    });

    it('derives both Supabase roles from the same freshly saved signing secret within one generation scope', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const common = { audience: {}, expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials };
            const source = { services: { web: { image: 'supabase/app:fixture', environment: {
                ANON_KEY: '${anon_key}', SERVICE_ROLE_KEY: '${service_role_key}', JWT_SECRET: '${jwt_secret}',
            } } } };
            const normalized = normalizeDokployTemplateV1({ title: 'Supabase', templateId: 'supabase', document: JSON.stringify(source),
                template: "[variables]\njwt_secret = \"${password:32}\"\nanon_key = \"${jwt:jwt_secret:anon_payload}\"\nservice_role_key = \"${jwt:jwt_secret:service_payload}\"\nanon_payload = '{\"role\":\"anon\",\"iss\":\"supabase\",\"exp\":1893456000}'\nservice_payload = '{\"role\":\"service_role\",\"iss\":\"supabase\",\"exp\":1893456000}'\n",
            });
            if (normalized.state !== 'ready') throw new Error('Supabase descriptor unavailable');
            const prepared = prepareDeploymentTemplateInstantiationV1({ template: normalized.app, source,
                templateRef: { sourceId: 'apps', itemId: 'supabase', version: '1', ref: { kind: 'content', digest: 'sha256:' + 'a'.repeat(64) } },
                bindings: buildCatalogAppTemplateBindings(normalized.app).bindings });
            const sources = await fixture.inHome(() => withDeploymentTemplateGeneratedSecretsForHost(async create => {
                const refs = [];
                for (const secret of prepared.generatedSecrets) refs.push(await create({ ...common, name: secret.name, key: secret.key, phase: secret.phase, profile: secret.profile }));
                return refs;
            }));
            const signing = fixture.opened(fixture.writes[0]!)?.value;
            if (typeof signing !== 'string') throw new Error('Missing signing key');
            expect(fixture.writes).toHaveLength(3);
            for (const [index, role] of ['anon', 'service_role'].entries()) {
                const token = fixture.opened(fixture.writes[index + 1]!)?.value;
                if (typeof token !== 'string') throw new Error('Missing JWT');
                const [header, payload, signature] = token.split('.');
                expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
                expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ role, iss: 'supabase', exp: 1893456000 });
                expect(signature).toBe(createHmac('sha256', signing).update(header + '.' + payload).digest('base64url'));
                expect(JSON.stringify(sources)).not.toContain(token);
            }
            expect(JSON.stringify(sources)).not.toContain(signing);
        } finally { await fixture.close(); }
    });

    it('refuses a hash profile made only from a literal instead of host entropy', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            await expect(fixture.inHome(() => createDeploymentTemplateGeneratedSecretForHost({ name: 'Hash', audience: {},
                expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials,
                profile: { kind: 'hex-characters', parts: ['known_value'] },
            }))).rejects.toMatchObject({ code: 'invalid_parameters' });
            expect(fixture.writes).toEqual([]);
        } finally { await fixture.close(); }
    });

    it('keeps build and runtime signing dependencies separate when both phases generate the same key', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const common = { audience: {}, expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials };
            await fixture.inHome(() => withDeploymentTemplateGeneratedSecretsForHost(async create => {
                for (const phase of ['build', 'runtime'] as const) await create({ ...common, phase,
                    key: 'signing', name: phase, profile: { kind: 'hex-32-bytes' } });
                for (const phase of ['build', 'runtime'] as const) await create({ ...common, phase,
                    key: 'token', name: phase, profile: { kind: 'jwt-hs256', secretKey: 'signing',
                        payload: { role: 'anon', iss: 'supabase', exp: 1893456000 } } });
            }));
            for (const index of [0, 1]) {
                const key = fixture.opened(fixture.writes[index]!)?.value;
                const token = fixture.opened(fixture.writes[index + 2]!)?.value;
                if (typeof key !== 'string' || typeof token !== 'string') throw new Error('Missing generated value');
                const [header, payload, signature] = token.split('.');
                expect(signature).toBe(createHmac('sha256', key).update(header + '.' + payload).digest('base64url'));
            }
        } finally { await fixture.close(); }
    });

    it('refuses an unavailable signing dependency without writing a Saved Secret', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            await expect(createDeploymentTemplateGeneratedSecretForHost({ name: 'Token', audience: {}, expectedScopeKey: 'unused',
                signal: new AbortController().signal, readCredentials: async () => null,
                profile: { kind: 'jwt-hs256', secretKey: 'missing', payload: { role: 'anon', iss: 'supabase', exp: 1893456000 } },
            })).rejects.toMatchObject({ code: 'invalid_parameters' });
            expect(fixture.writes).toEqual([]);
        } finally { await fixture.close(); }
    });

    it('cancels an admitted generation while acquiring Account credentials before any resource write', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const controller = new AbortController();
            await expect(fixture.inHome(() => createDeploymentTemplateGeneratedSecretForHost({
                name: 'Database password', profile: { kind: 'hex-32-bytes' }, audience: {},
                expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: controller.signal,
                readCredentials: async () => { controller.abort(); return credentials; },
            }))).rejects.toMatchObject({ name: 'AbortError' });
            expect(fixture.writes).toEqual([]);
        } finally { await fixture.close(); }
    });

    it('refuses a new credential acquisition for another Account', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'another-account' })).toString('base64url')}.signature`;
            await expect(fixture.inHome(() => createDeploymentTemplateGeneratedSecretForHost({
                name: 'Database password', profile: { kind: 'hex-32-bytes' }, audience: {},
                expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => ({ ...credentials, token }),
            }))).rejects.toMatchObject({ code: 'plugin_secret_custody_unavailable' });
            expect(fixture.writes).toEqual([]);
        } finally { await fixture.close(); }
    });

    it('accepts a generated value at the existing Saved Secret string boundary', async () => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            await fixture.inHome(() => createDeploymentTemplateGeneratedSecretForHost({
                name: 'Boundary credential',
                // Account settings owns the existing 64 KiB string contract;
                // hexadecimal encodes each random byte as two ASCII bytes.
                profile: { kind: 'hex-bytes', bytes: 32 * 1024 }, audience: {},
                expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials,
            }));
            expect(fixture.writes).toHaveLength(1);
            expect(fixture.opened(fixture.writes[0]!)?.value).toHaveLength(64 * 1024);
        } finally { await fixture.close(); }
    });

    it.each<DeploymentTemplateSecretProfileV1>([
        { kind: 'alphanumeric-characters', characters: Number.MAX_SAFE_INTEGER },
        { kind: 'hex-bytes', bytes: Number.MAX_SAFE_INTEGER },
        { kind: 'base64-bytes', bytes: Number.MAX_SAFE_INTEGER },
        { kind: 'hex-characters', parts: ['sb_publishable_', Number.MAX_SAFE_INTEGER] },
    ])('rejects an unpersistable $kind size before allocating entropy or creating a resource', async profile => {
        const fixture = await createSavedSecretsCliHttpFixture();
        try {
            const credentials = await fixture.deps.readCredentialsFn?.();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            await expect(fixture.inHome(() => createDeploymentTemplateGeneratedSecretForHost({
                name: 'Oversized credential', profile, audience: {},
                expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
                signal: new AbortController().signal, readCredentials: async () => credentials,
            }))).rejects.toMatchObject({ code: 'invalid_parameters' });
            expect(fixture.writes).toEqual([]);
        } finally { await fixture.close(); }
    });
});
