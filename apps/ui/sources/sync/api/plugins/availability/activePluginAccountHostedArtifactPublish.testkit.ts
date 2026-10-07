import { vi } from 'vitest';

import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { createActivePluginAccountHostedArtifactPublisher } from './activePluginAccountHostedArtifactRead';

export function createLifetime(scope: ServerAccountScope) {
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

/** Real archive/envelope/currentness logic with HTTP, credential and active-client boundaries supplied by the test. */
export function createPublisher(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    currentness?: Readonly<{
        mode: 'plain' | 'e2ee';
        contentKeyFingerprint: string | null;
    }>;
    credentials?: AuthCredentials;
}>) {
    const captureRequestAuthority = vi.fn(async () => Object.freeze({
        scope: params.lifetime.scope,
        request: params.request,
        ...(params.credentials ? { credentials: params.credentials } : {}),
    }));
    return Object.freeze({
        publisher: createActivePluginAccountHostedArtifactPublisher({
            captureLifetime: () => params.lifetime,
            getServerSnapshot: () => Object.freeze({
                serverId: params.lifetime.scope.serverId,
                serverUrl: 'https://server.example',
                generation: 7,
            }),
            captureRequestAuthority,
            readAccountCurrentness: async () => Object.freeze({
                mode: params.currentness?.mode ?? 'plain',
                version: 1,
                signingKeyFingerprint: null,
                updatedAt: 0,
                contentKeyFingerprint: params.currentness?.contentKeyFingerprint ?? null,
            }),
            resolveStoredContentCompatibility: () => Object.freeze({
                status: 'available' as const,
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                headers: new Headers({
                    'Content-Type': 'application/json',
                    'x-happier-account-stored-content-protocol': '3',
                }),
            }),
        }),
        captureRequestAuthority,
    });
}
