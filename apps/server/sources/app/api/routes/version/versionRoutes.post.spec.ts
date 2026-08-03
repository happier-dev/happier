import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRouteTestBuilder } from '../../testkit/routeTestBuilder';
import { versionRoutes } from './versionRoutes';

const APP_STORE_URL = 'https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388';

describe('versionRoutes POST /v1/version', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    async function invoke(body: Record<string, unknown>) {
        const route = createRouteTestBuilder({
            method: 'POST',
            path: '/v1/version',
            registerRoutes(app) {
                versionRoutes(app as never);
            },
        });
        const { reply, response } = await route.invoke({ body });
        const sentResponse = reply.send.mock.calls.at(-1)?.[0];
        return {
            statusCode: reply.statusCode as number,
            response: response ?? sentResponse,
        };
    }

    function stubCompatibilityMinimums(minimums: Record<string, string>) {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'required');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION', '2');
        vi.stubEnv(
            'HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON',
            JSON.stringify(minimums),
        );
    }

    it('reports the shipped iOS version as current when no policy minimum is configured', async () => {
        await expect(invoke({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 200,
            response: { update_required: false, update_url: null },
        });
    });

    it('requires an iOS upgrade from the policy minimum and retains the App Store destination', async () => {
        stubCompatibilityMinimums({ 'ui-ios': '0.3.0' });

        await expect(invoke({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 200,
            response: { update_required: true, update_url: APP_STORE_URL },
        });
    });

    it('prefers the policy upgrade URL over the built-in App Store destination', async () => {
        stubCompatibilityMinimums({ 'ui-ios': '0.3.0' });
        vi.stubEnv(
            'HAPPIER_SESSION_SYNC_COMPATIBILITY__UPGRADE_URLS_JSON',
            JSON.stringify({ 'ui-ios': 'https://happier.dev/upgrade' }),
        );

        await expect(invoke({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 200,
            response: { update_required: true, update_url: 'https://happier.dev/upgrade' },
        });
    });

    it('does not bypass a configured Android minimum for a development app id', async () => {
        stubCompatibilityMinimums({ 'ui-android': '0.3.0' });

        await expect(invoke({
            platform: 'android',
            version: '0.2.10',
            app_id: 'dev.happier.app.publicdev',
        })).resolves.toEqual({
            statusCode: 200,
            response: { update_required: true, update_url: null },
        });
    });

    it('fails closed when required enforcement has an unusable policy', async () => {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'required');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION', '2');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON', '{"ui-ios":"1.2"}');

        await expect(invoke({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 500,
            response: { error: 'compatibility_policy_invalid' },
        });
    });

    it('reports current when an unusable policy is observe-only', async () => {
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT', 'observe');
        vi.stubEnv('HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON', '{"ui-ios":"1.2"}');

        await expect(invoke({
            platform: 'ios',
            version: '0.2.10',
            app_id: 'dev.happier.app',
        })).resolves.toEqual({
            statusCode: 200,
            response: { update_required: false, update_url: null },
        });
    });
});
