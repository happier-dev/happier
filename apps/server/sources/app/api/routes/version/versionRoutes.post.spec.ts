import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientVersionCheckResponseV1Schema } from '@happier-dev/protocol';
import { createRouteTestBuilder } from '../../testkit/routeTestBuilder';

const APP_STORE_URL = 'https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388';

describe('versionRoutes POST /v1/version', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    async function invokeWithStatus(body: Record<string, unknown>) {
        const { versionRoutes } = await import('./versionRoutes');
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v1/version',
            registerRoutes(app) {
                versionRoutes(app as never);
            },
        });
        const { reply, response } = await route.invoke({ body });
        return { statusCode: reply.statusCode as number, response };
    }

    async function invokeRaw(body: Record<string, unknown>) {
        return (await invokeWithStatus(body)).response;
    }

    async function invoke(body: Record<string, unknown>) {
        return ClientVersionCheckResponseV1Schema.parse(await invokeRaw(body));
    }

    function stubCompatibilityMinimums(minimums: Record<string, string>) {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'required');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION', '2');
        vi.stubEnv(
            'HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON',
            JSON.stringify(minimums),
        );
    }

    it('reports a store-channel iOS build on the shipped version line as current', async () => {
        await expect(invoke({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '0.2.10',
            releaseChannel: 'production',
            appId: 'dev.happier.app',
        })).resolves.toEqual({ v: 1, status: 'current' });
    });

    it('reports a development-channel build as current', async () => {
        await expect(invoke({
            v: 1,
            clientKind: 'ui-android',
            appVersion: '0.2.10',
            releaseChannel: 'dev',
            appId: 'dev.happier.app.publicdev',
        })).resolves.toEqual({ v: 1, status: 'current' });
    });

    it('requires an upgrade from the configured compatibility minimum and links iOS to the App Store', async () => {
        stubCompatibilityMinimums({ 'ui-ios': '0.3.0' });

        await expect(invoke({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '0.2.10',
            releaseChannel: 'production',
            appId: 'dev.happier.app',
        })).resolves.toEqual({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '0.3.0',
            updateUrl: APP_STORE_URL,
        });
    });

    it('keeps the required upgrade truthful when no safe Android update URL is configured', async () => {
        stubCompatibilityMinimums({ 'ui-android': '0.3.0' });

        await expect(invoke({
            v: 1,
            clientKind: 'ui-android',
            appVersion: '0.2.10',
            releaseChannel: 'production',
            appId: 'dev.happier.app',
        })).resolves.toEqual({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '0.3.0',
            updateUrl: null,
        });
    });

    it('applies the configured compatibility minimum to a development-channel build', async () => {
        stubCompatibilityMinimums({ 'ui-android': '0.3.0' });

        await expect(invoke({
            v: 1,
            clientKind: 'ui-android',
            appVersion: '0.2.10',
            releaseChannel: 'dev',
            appId: 'dev.happier.app.publicdev',
        })).resolves.toEqual({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '0.3.0',
            updateUrl: null,
        });
    });

    it('prefers a configured upgrade URL over the built-in App Store link', async () => {
        stubCompatibilityMinimums({ 'ui-ios': '0.3.0' });
        vi.stubEnv(
            'HAPPIER_SESSION_SYNC_COMPATIBILITY__UPGRADE_URLS_JSON',
            JSON.stringify({ 'ui-ios': 'https://happier.dev/upgrade' }),
        );

        await expect(invoke({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '0.2.10',
            appId: 'dev.happier.app',
        })).resolves.toEqual({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '0.3.0',
            updateUrl: 'https://happier.dev/upgrade',
        });
    });

    it('keeps the deployed legacy native request/response shape working', async () => {
        await expect(invokeRaw({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            update_required: false,
            update_url: null,
        });
    });

    it('refuses to answer when enforcement is required and the configured minimums are unusable', async () => {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'required');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION', '2');
        // '1.2' is not comparable semver, so the whole policy resolves as invalid.
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON', '{"ui-ios":"1.2"}');

        await expect(invokeWithStatus({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '0.2.10',
            appId: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 500,
            response: { error: 'compatibility_policy_invalid' },
        });
    });

    it('refuses to answer a legacy check when enforcement is required and the policy is unusable', async () => {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'required');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION', '2');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON', '{"ui-ios":"1.2"}');

        await expect(invokeWithStatus({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 500,
            response: { error: 'compatibility_policy_invalid' },
        });
    });

    it('reports current when an unusable policy is only observed', async () => {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'observe');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON', '{"ui-ios":"1.2"}');

        await expect(invoke({
            v: 1,
            clientKind: 'ui-ios',
            appVersion: '0.2.10',
            appId: 'dev.happier.app',
        })).resolves.toEqual({ v: 1, status: 'current' });
    });

    it('reports a legacy required upgrade from the configured compatibility minimum', async () => {
        stubCompatibilityMinimums({ 'ui-ios': '0.3.0' });

        await expect(invokeRaw({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            update_required: true,
            update_url: APP_STORE_URL,
        });
    });
});
