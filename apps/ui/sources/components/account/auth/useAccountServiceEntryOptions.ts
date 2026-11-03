import * as React from 'react';

import {
    accountDirectoryAuthClient,
    type AccountDirectoryAuthTransport,
    type AccountDirectoryAuthMethodDiscovery,
} from '@/auth/accountDirectory/accountDirectoryAuthClient';
import {
    resolveEffectiveSignInService,
    type EffectiveSignInService,
} from '@happier-dev/cli-common/accountService';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import type { HomeSignInServicePolicyV1 } from '@happier-dev/protocol';
import {
    resolveSelectedAccountServiceEndpoint,
    subscribeAccountServiceEndpoint,
    type AccountServiceEndpointV1,
} from '@/sync/domains/server/serverProfiles';

export type AccountServiceEntryOptions = Readonly<{
    effectiveSignInService: EffectiveSignInService;
    /** The selected sign-in service. Exists before any Home profile, focused Home, or Sync runtime. */
    endpoint: AccountServiceEndpointV1;
    /**
     * `unsupported` identifies an ordinary Home without Account Directory. `unavailable` covers
     * an unreachable endpoint, stable-identity mismatch, or malformed advertisement. Welcome
     * keeps the selected service authoritative in either case and presents recovery actions.
     */
    status: 'not_offered' | 'loading' | 'ready' | 'unavailable' | 'unsupported';
    /** The service's own advertised methods. Non-null only while `status` is `ready`. */
    discovery: AccountDirectoryAuthMethodDiscovery | null;
    /** Ephemeral transport for this exact verified operation; never persisted or placed in navigation. */
    transport: AccountDirectoryAuthTransport;
    /** Re-runs discovery against this exact selected endpoint. */
    retry: () => void;
}>;

export type AccountServiceEntryTargetContext =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'home';
        target: HomeTargetInput;
        policy?: HomeSignInServicePolicyV1;
        selfService?: Readonly<{
            endpointUrl: string;
            expectedServerIdentityId?: string;
        }> & AccountDirectoryAuthTransport;
    }>;

type AccountServiceEntryProbeTarget = Readonly<{
    endpoint: AccountServiceEndpointV1;
    transport: AccountDirectoryAuthTransport;
    key: string;
}>;

const noAccountServiceTargetContext: AccountServiceEntryTargetContext = Object.freeze({ kind: 'none' });

function effectiveSignInServiceKey(effective: EffectiveSignInService): string {
    if (effective.kind === 'not_offered') return 'not_offered';
    if (effective.kind === 'self') return `self|${JSON.stringify(effective.target)}`;
    return [effective.kind, effective.endpoint, effective.expectedServerIdentityId ?? ''].join('|');
}

export function resolveAccountServiceEntryProbeTarget(input: Readonly<{
    targetContext: AccountServiceEntryTargetContext;
    deviceSelection: AccountServiceEndpointV1;
}>): Readonly<{ effective: EffectiveSignInService; probe: AccountServiceEntryProbeTarget | null }> {
    const effective = resolveEffectiveSignInService({
        targetContext: input.targetContext,
        deviceSelection: input.targetContext.kind === 'none' && input.deviceSelection.url
            ? {
                endpoint: input.deviceSelection.url,
                ...(input.deviceSelection.serverIdentityId
                    ? { expectedServerIdentityId: input.deviceSelection.serverIdentityId }
                    : {}),
            }
            : undefined,
    });
    if (effective.kind === 'not_offered') return { effective, probe: null };
    if (effective.kind === 'self') {
        const service = input.targetContext.kind === 'home' ? input.targetContext.selfService : undefined;
        if (!service) return { effective, probe: null };
        const endpoint: AccountServiceEndpointV1 = {
            url: service.endpointUrl,
            source: 'default',
            ...(service.expectedServerIdentityId ? { serverIdentityId: service.expectedServerIdentityId } : {}),
        };
        return {
            effective,
            probe: {
                endpoint,
                transport: {
                    ...(service.runtimeOrigin ? { runtimeOrigin: service.runtimeOrigin } : {}),
                    ...(service.homeCarrier ? { homeCarrier: service.homeCarrier } : {}),
                },
                key: ['self', endpoint.url, endpoint.serverIdentityId ?? '', service.runtimeOrigin ?? '', service.homeCarrier?.endpointId ?? ''].join('|'),
            },
        };
    }
    const endpoint: AccountServiceEndpointV1 = effective.kind === 'no_target_default'
        ? input.deviceSelection
        : {
            url: effective.endpoint,
            source: 'default',
            ...(effective.expectedServerIdentityId ? { serverIdentityId: effective.expectedServerIdentityId } : {}),
        };
    return {
        effective,
        probe: {
            endpoint,
            transport: {},
            key: [effective.kind, endpoint.url, endpoint.serverIdentityId ?? ''].join('|'),
        },
    };
}

/**
 * Advertised authentication methods of the selected sign-in service, read straight from that exact
 * endpoint through Lane 01's explicit endpoint boundary.
 *
 * This deliberately does not consult `useAuthEntryOptions`, the focused Home, or any Home runtime:
 * a focused Home must not be able to retarget sign-in-service discovery. Discovery is a plain
 * capability probe — it creates no `ServerProfile`, group member, Sync runtime, or Socket.IO target,
 * and it never writes a credential.
 */
export function useAccountServiceEntryOptions(
    targetContext: AccountServiceEntryTargetContext = noAccountServiceTargetContext,
): AccountServiceEntryOptions {
    const deviceSelection = React.useSyncExternalStore(
        (listener) => subscribeAccountServiceEndpoint(() => listener()),
        resolveSelectedAccountServiceEndpoint,
        resolveSelectedAccountServiceEndpoint,
    );
    const unresolvedTarget = resolveAccountServiceEntryProbeTarget({ targetContext, deviceSelection });
    const unresolvedProbe = unresolvedTarget.probe;
    const effectiveKey = effectiveSignInServiceKey(unresolvedTarget.effective);
    const effectiveSignInService = React.useMemo(
        () => unresolvedTarget.effective,
        [effectiveKey],
    );
    const probe = React.useMemo(
        () => unresolvedProbe,
        [
            unresolvedProbe?.key,
            unresolvedProbe?.endpoint.url,
            unresolvedProbe?.endpoint.serverIdentityId,
            unresolvedProbe?.endpoint.displayName,
            unresolvedProbe?.endpoint.source,
            unresolvedProbe?.transport.runtimeOrigin,
            unresolvedProbe?.transport.homeCarrier,
        ],
    );
    const endpoint = probe?.endpoint ?? deviceSelection;
    const endpointUrl = endpoint.url;
    const expectedServerIdentityId = endpoint.serverIdentityId ?? null;
    const [resolved, setResolved] = React.useState<Readonly<{
        key: string;
        status: 'not_offered' | 'loading' | 'ready' | 'unavailable' | 'unsupported';
        discovery: AccountDirectoryAuthMethodDiscovery | null;
    }>>({ key: probe?.key ?? 'not_offered', status: probe ? 'loading' : 'not_offered', discovery: null });
    const [retryGeneration, setRetryGeneration] = React.useState(0);

    React.useEffect(() => {
        if (!probe) {
            setResolved({ key: 'not_offered', status: 'not_offered', discovery: null });
            return;
        }
        const controller = new AbortController();
        const observationKey = probe.key;
        setResolved({ key: observationKey, status: 'loading', discovery: null });
        void (async () => {
            try {
                const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({
                    endpointUrl,
                    ...(expectedServerIdentityId ? { expectedServerIdentityId } : {}),
                    ...probe.transport,
                    signal: controller.signal,
                });
                if (controller.signal.aborted || observationKey !== probe.key) return;
                setResolved(discovery.kind === 'supported_account_service'
                    ? { key: observationKey, status: 'ready', discovery }
                    : discovery.kind === 'not_account_service'
                        ? { key: observationKey, status: 'unsupported', discovery: null }
                        : { key: observationKey, status: 'unavailable', discovery: null });
            } catch {
                if (!controller.signal.aborted) setResolved({ key: observationKey, status: 'unavailable', discovery: null });
            }
        })();
        return () => {
            controller.abort();
        };
    }, [endpointUrl, expectedServerIdentityId, probe, retryGeneration]);

    const retry = React.useCallback(() => setRetryGeneration((generation) => generation + 1), []);

    const currentKey = probe?.key ?? 'not_offered';
    const currentResolved = resolved.key === currentKey
        ? resolved
        : { key: currentKey, status: probe ? 'loading' as const : 'not_offered' as const, discovery: null };

    return React.useMemo(() => ({
        effectiveSignInService,
        endpoint,
        status: currentResolved.status,
        discovery: currentResolved.discovery,
        transport: probe?.transport ?? {},
        retry,
    }), [effectiveSignInService, endpoint, currentResolved, probe?.transport, retry]);
}
