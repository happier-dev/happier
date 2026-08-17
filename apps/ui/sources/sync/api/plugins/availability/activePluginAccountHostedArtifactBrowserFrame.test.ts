import { describe, expect, it, vi } from 'vitest';

import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema,
} from '@happier-dev/protocol/plugins/availability';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    createActivePluginAccountHostedArtifactBrowserFrameIssuer,
    type ActivePluginAccountHostedArtifactBrowserFrameIssuerDependencies,
} from './activePluginAccountHostedArtifactBrowserFrame';

const scope: ServerAccountScope = Object.freeze({
    serverId: 'server-a',
    accountId: 'account-a',
});

const release = Object.freeze({
    pluginId: 'com.acme.hosted',
    version: '1.2.3',
});

const slot = Object.freeze({
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});

const expectedArtifactDigest = PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema
    .shape.expectedArtifactDigest.parse(`sha256:${'a'.repeat(64)}`);

function createLifetime() {
    let current = true;
    const retireListeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope,
        isCurrent: () => current,
        onRetire: (listener) => {
            retireListeners.add(listener);
            return Object.freeze({ dispose: () => retireListeners.delete(listener) });
        },
    });
    return Object.freeze({
        lifetime,
        retire: () => {
            current = false;
            for (const listener of [...retireListeners]) listener();
        },
    });
}

function createIssuer(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    getServerSnapshot?: ActivePluginAccountHostedArtifactBrowserFrameIssuerDependencies['getServerSnapshot'];
}>) {
    const captureRequestAuthority = vi.fn(async () => Object.freeze({
        request: params.request,
    }));
    const issuer = createActivePluginAccountHostedArtifactBrowserFrameIssuer({
        getServerSnapshot: params.getServerSnapshot ?? (() => Object.freeze({
            serverId: scope.serverId,
            generation: 7,
        })),
        captureRequestAuthority,
    });
    return Object.freeze({ issuer, captureRequestAuthority });
}

function input(accountLifetime: ActiveServerAccountScopeLifetime) {
    return Object.freeze({
        accountLifetime,
        release,
        slot,
        expectedArtifactDigest,
    });
}

describe('active Account browser Artifact-frame issuer', () => {
    it('uses only the exact scoped Availability issue action and returns its strict HTTPS capability URL', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({
            url: 'https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/hwb1.fixture.signature/',
            expiresAt: 1_800_000_000_000,
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createIssuer({ lifetime, request });

        await expect(current.issuer.issue(input(lifetime))).resolves.toEqual({
            kind: 'available',
            value: {
                url: 'https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/hwb1.fixture.signature/',
                expiresAt: 1_800_000_000_000,
            },
        });

        expect(current.captureRequestAuthority).toHaveBeenCalledWith({
            scope,
            activeRequest: expect.any(Function),
        });
        expect(request).toHaveBeenCalledTimes(1);
        const [path, init] = request.mock.calls[0]!;
        expect(path).toBe(PluginAvailabilityActionHttpPathsV1[
            'account.plugins.availability.uiArtifact.browserFrame.issue'
        ]);
        expect(JSON.parse(String(init?.body))).toEqual({
            release,
            ...slot,
            expectedArtifactDigest,
        });
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    });

    it('keeps E2EE browser issuance typed unavailable without attempting an Artifact read path', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async () => new Response(JSON.stringify({
            error: 'plugin_ui_artifact_browser_e2ee_unavailable',
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createIssuer({ lifetime, request });

        await expect(current.issuer.issue(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'e2ee_unavailable',
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('fails closed when a supported predecessor server has no browser-frame issue action', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async () => new Response(JSON.stringify({
            error: 'Not found',
        }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createIssuer({ lifetime, request });

        await expect(current.issuer.issue(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'transport_unavailable',
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('keeps an absent dedicated browser Artifact origin as a typed hosting failure', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async () => new Response(JSON.stringify({
            error: 'plugin_ui_artifact_hosting_unsupported',
        }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createIssuer({ lifetime, request });

        await expect(current.issuer.issue(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_hosting_unsupported',
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('preserves the Account owner\'s explicit Artifact-hosting opt-out instead of misreporting transport failure', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async () => new Response(JSON.stringify({
            error: 'plugin_ui_artifact_hosting_not_opted_in',
        }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createIssuer({ lifetime, request });

        await expect(current.issuer.issue(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_hosting_not_opted_in',
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('drops a capability response that arrives after its Account lifetime retires', async () => {
        const active = createLifetime();
        const request = vi.fn(async () => {
            active.retire();
            return new Response(JSON.stringify({
            url: 'https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/hwb1.fixture.signature/',
                expiresAt: 1_800_000_000_000,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const current = createIssuer({ lifetime: active.lifetime, request });

        await expect(current.issuer.issue(input(active.lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'account_scope_changed',
        });
    });
});
