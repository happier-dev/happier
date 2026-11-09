import { describe, expect, it } from 'vitest';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { DeploymentTemplateSecretProfileV1 } from '@happier-dev/protocol/registries';

import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDeploymentTemplateGeneratedSecretForHost } from './generatedSecretForHost';

const cases: ReadonlyArray<Readonly<{ profile: DeploymentTemplateSecretProfileV1; pattern: RegExp; decodedBytes?: number }>> = [
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
