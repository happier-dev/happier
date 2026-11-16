import { afterEach, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { refreshDegradedHomeDescriptor } from './refreshDegradedHomeDescriptor';

const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_degraded',
    canonicalServerUrl: 'https://canonical.example.test', revision: 7,
    endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) },
        { kind: 'https' as const, url: 'https://declared.example.test' }] };
afterEach(async () => { resetRuntimeFetch(); resetServerFeaturesClientForTests();
    profiles.resetServerProfilesRuntimeForTests(); await resetServerReachabilitySupervisors(); vi.restoreAllMocks(); });

it.each(['unchanged', 'https-only', 'stale', 'equal-conflict', 'absent', 'wrong-home', 'no-https'] as const)(
    'refreshes a degraded Home once and renegotiates only an adopted higher revision: %s', async (scenario) => {
        const original = scenario === 'no-https' ? { ...descriptor, endpoints: descriptor.endpoints.slice(0, 1) } : descriptor;
        const home = await profiles.adoptHomeProfile({ descriptor: original, source: 'manual',
            descriptorAuthority: 'current_connection_observation' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const next = scenario === 'https-only' || scenario === 'stale' || scenario === 'equal-conflict'
            ? { ...descriptor, revision: scenario === 'https-only' ? 8 : scenario === 'stale' ? 6 : 7,
                endpoints: descriptor.endpoints.slice(1) } : descriptor;
        const urls: string[] = [];
        setRuntimeFetch(async (input) => {
            const url = String(input); urls.push(url);
            return Response.json(url.includes('/v1/features') ? createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId: scenario === 'wrong-home' ? 'srv_other' : descriptor.homeServerIdentityId } },
                ...(scenario === 'absent' ? {} : { homeConnectionDescriptor: next }),
            }) : { ok: true });
        });
        expect(await refreshDegradedHomeDescriptor(home, { token: 'synthetic-token' })).toBe(scenario === 'https-only');
        expect(urls.filter(url => url.endsWith('/v1/features/authenticated'))).toHaveLength(
            scenario === 'no-https' || scenario === 'wrong-home' ? 0 : 1);
        expect(urls.every(url => new URL(url).origin === 'https://declared.example.test')).toBe(true);
        expect(profiles.getServerProfileById(home.id)?.homeConnectionDescriptor).toEqual(scenario === 'https-only' ? next : original);
    });
