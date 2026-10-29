import { describe, expect, it } from 'vitest';
import { buildHomeConfigEnv } from '@/app/home/settings/homeConfigOverlay';
import { resolvePublicProfilePrerequisite, resolvePublicProfileServiceName } from './publicProfileContext';

describe('public-profile service name', () => {
    it.each([
        [{ HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test:8443/prefix' }, 'profiles.example.test'],
        [{ HAPPIER_PUBLIC_SERVER_URL: 'http://[2001:db8::1]:3025/profiles' }, '[2001:db8::1]'],
        [{ HAPPIER_PUBLIC_SERVER_URL: 'https://münich.example/profiles' }, 'xn--mnich-kva.example'],
        [{ HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test/prefix', HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'My service' }, 'My service'],
    ])('uses the configured display name or the public host only', (env, expected) => {
        expect(resolvePublicProfileServiceName(env)).toBe(expected);
    });
});

describe('public-profile publication prerequisites', () => {
    it('uses admitted ingress and the same validated report contact for env and Home configuration', () => {
        const env = { HAPPIER_PUBLIC_SERVER_URL: 'http://localhost:3000/prefix' };
        expect(resolvePublicProfilePrerequisite(env)).toBe('report_contact_unconfigured');
        expect(resolvePublicProfilePrerequisite({ HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' })).toBe('public_ingress_unconfigured');
        expect(resolvePublicProfilePrerequisite({ ...env, HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'javascript:alert(1)' })).toBe('report_contact_unconfigured');
        expect(resolvePublicProfilePrerequisite(buildHomeConfigEnv({}, {
            HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test/prefix', HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test',
        }))).toBeNull();
    });
});
