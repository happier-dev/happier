import { apiSocket } from '@/sync/api/session/apiSocket';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema,
    PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema,
    type PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1,
    type PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1,
} from '@happier-dev/protocol/plugins/availability';

type BrowserArtifactFrameServerSnapshot = Readonly<{
    serverId: string | null;
    generation: number;
}>;

type BrowserArtifactFrameRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
}>;

export type ActivePluginAccountHostedArtifactBrowserFrameIssueInput = Readonly<{
    /** The mounted surface captures this exact active Account lifetime. */
    accountLifetime: ActiveServerAccountScopeLifetime;
    release: PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1['release'];
    slot: Readonly<{
        contributionId: PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1['contributionId'];
        tier: PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1['tier'];
        platform: PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1['platform'];
    }>;
    expectedArtifactDigest: PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1['expectedArtifactDigest'];
    /** The caller can abandon this mount-local capability request. */
    signal?: AbortSignal;
}>;

type ActivePluginAccountHostedArtifactBrowserFrameUnavailableCode =
    | 'account_scope_changed'
    | 'artifact_hosting_not_opted_in'
    | 'artifact_hosting_unsupported'
    | 'e2ee_unavailable'
    | 'operation_cancelled'
    | 'response_invalid'
    | 'server_generation_changed'
    | 'transport_unavailable';

type ActivePluginAccountHostedArtifactBrowserFrameUnavailable = Readonly<{
    kind: 'unavailable';
    code: ActivePluginAccountHostedArtifactBrowserFrameUnavailableCode;
}>;

export type ActivePluginAccountHostedArtifactBrowserFrameIssueResult =
    | Readonly<{
        kind: 'available';
        /** Ephemeral mount-local value; this owner never persists or caches it. */
        value: PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1;
    }>
    | ActivePluginAccountHostedArtifactBrowserFrameUnavailable;

export type ActivePluginAccountHostedArtifactBrowserFrameIssuer = Readonly<{
    issue: (
        input: ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
    ) => Promise<ActivePluginAccountHostedArtifactBrowserFrameIssueResult>;
}>;

export type ActivePluginAccountHostedArtifactBrowserFrameIssuerDependencies = Readonly<{
    getServerSnapshot: () => BrowserArtifactFrameServerSnapshot;
    captureRequestAuthority: (input: Readonly<{
        scope: ServerAccountScope;
        activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
    }>) => Promise<BrowserArtifactFrameRequestAuthority>;
}>;

function unavailable(
    code: ActivePluginAccountHostedArtifactBrowserFrameUnavailableCode,
): ActivePluginAccountHostedArtifactBrowserFrameUnavailable {
    return Object.freeze({ kind: 'unavailable', code });
}

function sameServerSnapshot(
    left: BrowserArtifactFrameServerSnapshot,
    right: BrowserArtifactFrameServerSnapshot,
): boolean {
    return left.serverId === right.serverId && left.generation === right.generation;
}

function readCurrentnessCode(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: BrowserArtifactFrameServerSnapshot;
    getServerSnapshot: () => BrowserArtifactFrameServerSnapshot;
}>): Extract<
    ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
    { kind: 'unavailable' }
>['code'] | null {
    if (!input.accountLifetime.isCurrent()) return 'account_scope_changed';
    return sameServerSnapshot(input.getServerSnapshot(), input.serverSnapshot)
        ? null
        : 'server_generation_changed';
}

function cancellationCode(input: Readonly<{
    signal?: AbortSignal;
}>): Extract<
    ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
    { kind: 'unavailable' }
>['code'] {
    return input.signal?.aborted === true ? 'operation_cancelled' : 'account_scope_changed';
}

function isE2eeUnavailableError(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as Readonly<Record<string, unknown>>).error
        === 'plugin_ui_artifact_browser_e2ee_unavailable';
}

function isArtifactHostingUnsupportedError(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as Readonly<Record<string, unknown>>).error
        === 'plugin_ui_artifact_hosting_unsupported';
}

function isArtifactHostingNotOptedInError(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as Readonly<Record<string, unknown>>).error
        === 'plugin_ui_artifact_hosting_not_opted_in';
}

function defaultDependencies(): ActivePluginAccountHostedArtifactBrowserFrameIssuerDependencies {
    return {
        getServerSnapshot: () => {
            const snapshot = getActiveServerSnapshot();
            return {
                serverId: snapshot.serverId,
                generation: snapshot.generation,
            };
        },
        captureRequestAuthority: async ({ scope, activeRequest }) => {
            const authority = await captureSessionRequestAuthorityForServerAccountScope({
                scope,
                activeRequest,
            });
            return Object.freeze({ request: authority.request });
        },
    };
}

/**
 * The browser-only Artifact admission client. It invokes exactly the
 * authenticated issuance action and returns a transient signed URL to the
 * mounted frame. It neither reads Artifact envelopes nor chooses a byte
 * source, cache, daemon, service worker, or local fallback.
 */
export function createActivePluginAccountHostedArtifactBrowserFrameIssuer(
    overrides: Partial<ActivePluginAccountHostedArtifactBrowserFrameIssuerDependencies> = {},
): ActivePluginAccountHostedArtifactBrowserFrameIssuer {
    const dependencies: ActivePluginAccountHostedArtifactBrowserFrameIssuerDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };

    const issue = async (
        input: ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
    ): Promise<ActivePluginAccountHostedArtifactBrowserFrameIssueResult> => {
        if (input.signal?.aborted) return unavailable('operation_cancelled');
        if (!input.accountLifetime.isCurrent()) return unavailable('account_scope_changed');

        const serverSnapshot = dependencies.getServerSnapshot();
        if (serverSnapshot.serverId !== input.accountLifetime.scope.serverId) {
            return unavailable('server_generation_changed');
        }
        const request = PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema.safeParse({
            release: input.release,
            ...input.slot,
            expectedArtifactDigest: input.expectedArtifactDigest,
        });
        if (!request.success) return unavailable('response_invalid');

        const controller = new AbortController();
        const abort = () => controller.abort();
        const retirement = input.accountLifetime.onRetire(abort);
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        try {
            const beforeAuthority = readCurrentnessCode({
                accountLifetime: input.accountLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (beforeAuthority) return unavailable(beforeAuthority);
            if (controller.signal.aborted) return unavailable(cancellationCode(input));

            const authority = await dependencies.captureRequestAuthority({
                scope: input.accountLifetime.scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            const afterAuthority = readCurrentnessCode({
                accountLifetime: input.accountLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (afterAuthority) return unavailable(afterAuthority);
            if (controller.signal.aborted) return unavailable(cancellationCode(input));

            let response: Response;
            try {
                response = await authority.request(
                    PluginAvailabilityActionHttpPathsV1[
                        'account.plugins.availability.uiArtifact.browserFrame.issue'
                    ],
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(request.data),
                        signal: controller.signal,
                    },
                );
            } catch {
                const currentness = readCurrentnessCode({
                    accountLifetime: input.accountLifetime,
                    serverSnapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (currentness) return unavailable(currentness);
                return unavailable(controller.signal.aborted
                    ? cancellationCode(input)
                    : 'transport_unavailable');
            }

            const afterResponse = readCurrentnessCode({
                accountLifetime: input.accountLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (afterResponse) return unavailable(afterResponse);
            if (controller.signal.aborted) return unavailable(cancellationCode(input));

            const raw = await response.json().catch(() => null);
            const afterBody = readCurrentnessCode({
                accountLifetime: input.accountLifetime,
                serverSnapshot,
                getServerSnapshot: dependencies.getServerSnapshot,
            });
            if (afterBody) return unavailable(afterBody);
            if (controller.signal.aborted) return unavailable(cancellationCode(input));
            if (!response.ok) {
                return unavailable(isE2eeUnavailableError(raw)
                    ? 'e2ee_unavailable'
                    : isArtifactHostingUnsupportedError(raw)
                        ? 'artifact_hosting_unsupported'
                        : isArtifactHostingNotOptedInError(raw)
                            ? 'artifact_hosting_not_opted_in'
                        : 'transport_unavailable');
            }

            const output = PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema.safeParse(raw);
            if (!output.success) return unavailable('response_invalid');
            return Object.freeze({ kind: 'available', value: output.data });
        } finally {
            input.signal?.removeEventListener('abort', abort);
            retirement.dispose();
        }
    };

    return Object.freeze({ issue });
}

const installedIssuer = createActivePluginAccountHostedArtifactBrowserFrameIssuer();

/** Direct browser frame issuance entry point; it has no Artifact byte fallback. */
export async function issueActivePluginAccountHostedArtifactBrowserFrame(
    input: ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
): Promise<ActivePluginAccountHostedArtifactBrowserFrameIssueResult> {
    return await installedIssuer.issue(input);
}
