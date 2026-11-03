import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePersonalHomeAdmission, resolveSetupSurfacePolicy } from '../server/setup/setupSurfacePolicy';
import { getFeatureBuildPolicyDecision } from '../features/featureBuildPolicy';
import { readConfiguredServerUrlEnv } from '../server/readConfiguredServerUrlEnv';

function desktopPolicy(value: Record<string, unknown> | string) {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('document', {});
    vi.stubGlobal('window', { location: { hostname: 'tauri.localhost' }, __HAPPIER_WEB_RUNTIME_CONFIG__: {
        organizationPolicyJson: typeof value === 'string' ? value : JSON.stringify({ schemaVersion: 1, organization: 'Example', ...value }),
    } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('organization policy setup and feature consumers', () => {
    it('names the organization behind a denied feature so Settings shows it as managed, not missing', async () => {
        desktopPolicy({ supportUrl: 'https://help.example.test', features: { deny: ['bots'] } });
        const { getOrganizationPolicyFeatureDenial } = await import('./organizationPolicy');
        expect(getFeatureBuildPolicyDecision('bots')).toBe('deny');
        expect(getOrganizationPolicyFeatureDenial('bots')).toEqual({ organization: 'Example', supportUrl: 'https://help.example.test' });
        expect(getOrganizationPolicyFeatureDenial('workflows')).toBeNull();
        const { resolveFeatureToggleSetting } = await import('@/components/settings/features/featuresSettings');
        expect(resolveFeatureToggleSetting('bots')).toBeDefined();
    });

    it('allows an explicit Personal Home choice above a policy default and below a policy lock', () => {
        desktopPolicy({ personalHome: { value: 'offer', locked: false } });
        expect(resolvePersonalHomeAdmission(undefined, { host: true, personalHome: 'auto' })).toBe('auto');
        expect(resolvePersonalHomeAdmission(undefined, { host: true })).toBe('offer');
        desktopPolicy({ personalHome: { value: 'off', locked: true } });
        expect(resolvePersonalHomeAdmission(undefined, { host: true, personalHome: 'auto' })).toBe('off');
    });

    it('fails new-install admission closed for invalid policy even with explicit choice', () => {
        desktopPolicy('{invalid');
        expect(resolvePersonalHomeAdmission(undefined, { host: true, personalHome: 'auto' })).toBe('off');
        expect(resolveSetupSurfacePolicy().relay.allowRelaySelection).toBe(false);
    });

    it('projects the locked Home over an explicit environment Home through existing enforcement', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', 'https://user.example.test');
        desktopPolicy({ home: { url: 'https://company.example.test', locked: true } });
        expect(readConfiguredServerUrlEnv()).toBe('https://company.example.test');
        expect(resolveSetupSurfacePolicy().relay).toMatchObject({ allowRelaySelection: false, enforcedServerUrl: 'https://company.example.test' });
    });

    it('feeds policy denials into the build policy while retaining build restrictions', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'voice');
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW', 'deployments');
        desktopPolicy({ features: { deny: ['deployments'] } });
        expect(getFeatureBuildPolicyDecision('deployments')).toBe('deny');
        expect(getFeatureBuildPolicyDecision('voice')).toBe('deny');
        desktopPolicy({});
        expect(getFeatureBuildPolicyDecision('deployments')).toBe('allow');
    });

    it('does not apply native policy fields to an ordinary web client', () => {
        desktopPolicy({ home: { url: 'https://company.example.test', locked: true } });
        vi.stubGlobal('isTauri', false);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', 'https://web.example.test');
        expect(readConfiguredServerUrlEnv()).toBe('https://web.example.test');
        expect(resolveSetupSurfacePolicy().relay.allowRelaySelection).toBe(true);
    });
});
