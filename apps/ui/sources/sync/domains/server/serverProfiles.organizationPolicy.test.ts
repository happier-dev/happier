import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Profiles = typeof import('./serverProfiles');
let profiles: Profiles;
const company = 'https://company.example.test';
const other = 'https://personal.example.test';

function startDesktop(policy?: Record<string, unknown> | string, query = '') {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('document', {});
    vi.stubGlobal('window', {
        location: { origin: 'http://tauri.localhost', hostname: 'tauri.localhost', href: `http://tauri.localhost/${query}` },
        __HAPPIER_WEB_RUNTIME_CONFIG__: policy === undefined ? {} : {
            organizationPolicyJson: typeof policy === 'string' ? policy : JSON.stringify({ schemaVersion: 1, organization: 'Example', ...policy }),
        },
    });
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    });
}

beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `org-policy-${Math.random()}`);
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({
        accountService: { url: 'https://build-account.example.test' },
        home: { url: 'https://build-home.example.test' }, personalHome: { value: 'offer' },
    }));
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_SERVER_URL', '');
    startDesktop();
    profiles = await import('./serverProfiles');
});

afterEach(() => { profiles?.resetServerProfilesRuntimeForTests(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('organization policy at endpoint owners', () => {
    it('uses build defaults without a policy and permits explicit selections', async () => {
        expect(profiles.resolveSelectedAccountServiceEndpoint().url).toBe('https://build-account.example.test');
        await profiles.setAccountServiceEndpoint({ url: other, source: 'user' });
        expect(profiles.resolveSelectedAccountServiceEndpoint().url).toBe(other);
    });

    it('applies policy defaults below deliberate user choices', async () => {
        startDesktop({ accountService: { url: company, locked: false }, home: { url: company, locked: false } });
        expect(profiles.resolveSelectedAccountServiceEndpoint().url).toBe(company);
        expect(profiles.getActiveServerUrl()).toBe(company);
        await profiles.setAccountServiceEndpoint({ url: other, source: 'user' });
        const selected = await profiles.upsertServerProfile({ serverUrl: other });
        await profiles.setActiveServerId(selected.id);
        expect(profiles.resolveSelectedAccountServiceEndpoint().url).toBe(other);
        expect(profiles.getActiveServerUrl()).toBe(other);
    });

    it('replaces a retained implicit build default with a policy default on restart', async () => {
        expect(profiles.getActiveServerUrl()).toBe('https://build-home.example.test');
        await profiles.upsertServerProfile({ serverUrl: other });
        startDesktop({ home: { url: company, locked: false } });
        profiles.resetServerProfilesRuntimeForTests();
        expect(profiles.getActiveServerUrl()).toBe(company);
    });

    it('projects locks without overwriting retained choices and restores them on restart without policy', async () => {
        await profiles.setAccountServiceEndpoint({ url: other, source: 'user' });
        const retained = await profiles.upsertServerProfile({ serverUrl: other });
        await profiles.setActiveServerId(retained.id);
        startDesktop({ accountService: { url: company, locked: true }, home: { url: company, locked: true } });
        profiles.resetServerProfilesRuntimeForTests();
        expect(profiles.resolveSelectedAccountServiceEndpoint().url).toBe(company);
        expect(profiles.getActiveServerUrl()).toBe(company);
        expect(profiles.getAccountServiceEndpointSnapshot()?.url).toBe(other);
        expect(() => profiles.setAccountServiceEndpoint({ url: other, source: 'user' })).toThrow();
        await expect(profiles.setActiveServerId(retained.id)).rejects.toMatchObject({ name: 'OrganizationPolicyActionError' });
        startDesktop();
        profiles.resetServerProfilesRuntimeForTests();
        expect(profiles.resolveSelectedAccountServiceEndpoint().url).toBe(other);
        expect(profiles.getActiveServerUrl()).toBe(other);
    });

    it.each(['qr', 'url'] as const)('refuses alternate Home adoption through %s', async (source) => {
        startDesktop({ home: { url: company, locked: true } });
        await expect(profiles.upsertServerProfile({ serverUrl: other, source })).rejects.toMatchObject({ name: 'OrganizationPolicyActionError' });
        await expect(profiles.upsertServerProfile({ serverUrl: company, source })).resolves.toMatchObject({ serverUrl: company });
    });

    it('enforces Home selection against URL, tab and environment overrides', async () => {
        const retained = await profiles.upsertServerProfile({ serverUrl: other });
        startDesktop({ home: { url: company, locked: true } }, `?server=${encodeURIComponent(other)}`);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', other);
        profiles.resetServerProfilesRuntimeForTests();
        expect(profiles.getActiveServerUrl()).toBe(company);
        expect(profiles.readWebServerEntry()).toMatchObject({ serverUrl: company, isAdmitted: true });
        await expect(profiles.setActiveServerId(retained.id, { scope: 'tab' })).rejects.toMatchObject({ name: 'OrganizationPolicyActionError' });
    });

    it('invalid policy refuses governed mutations while retained Home reads continue', async () => {
        const retained = await profiles.upsertServerProfile({ serverUrl: other });
        await profiles.setActiveServerId(retained.id);
        startDesktop('{broken');
        profiles.resetServerProfilesRuntimeForTests();
        expect(profiles.getActiveServerUrl()).toBe(other);
        expect(() => profiles.setAccountServiceEndpoint({ url: company, source: 'user' })).toThrow();
        await expect(profiles.setActiveServerId(retained.id)).rejects.toMatchObject({ name: 'OrganizationPolicyActionError' });
        await expect(profiles.upsertServerProfile({ serverUrl: company })).rejects.toMatchObject({ name: 'OrganizationPolicyActionError' });
    });

    it('keeps authenticated same-Home descriptor refresh usable with an invalid policy', async () => {
        const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_org_policy_retained',
            canonicalServerUrl: other, revision: 1, endpoints: [{ kind: 'https' as const, url: other }] };
        await profiles.adoptHomeProfile({ source: 'qr', descriptor });
        startDesktop('{broken');
        profiles.resetServerProfilesRuntimeForTests();
        await expect(profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: other, observedServerIdentityId: descriptor.homeServerIdentityId,
            descriptor: { ...descriptor, revision: 2 },
        })).resolves.toMatchObject({ kind: 'applied', profile: { homeConnectionDescriptor: { revision: 2 } } });
    });

    it('refuses an authenticated canonical Home retarget while its URL is locked', async () => {
        const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_org_policy_locked',
            canonicalServerUrl: company, revision: 1, endpoints: [{ kind: 'https' as const, url: company }] };
        await profiles.adoptHomeProfile({ source: 'qr', descriptor });
        startDesktop({ home: { url: company, locked: true } });
        profiles.resetServerProfilesRuntimeForTests();
        await expect(profiles.reconcileServerProfileHomeConnectionDescriptor({
            serverUrl: company, observedServerIdentityId: descriptor.homeServerIdentityId,
            descriptor: { ...descriptor, revision: 2, canonicalServerUrl: other },
        })).rejects.toMatchObject({ code: 'organization_policy_locked' });
        expect(profiles.getActiveServerUrl()).toBe(company);
    });
});
