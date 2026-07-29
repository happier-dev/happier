import {
    resolvePeerRouteKindForEndpointMechanism,
    type DirectPeerRouteKind,
    type PeerRouteViabilityRecord as TransferRouteViabilityRecord,
} from '@happier-dev/peer-mediation';

export type MachineDaemonTransferListenerClassState = Readonly<{
    enabled: boolean;
    configured: boolean;
    active: boolean;
    available?: boolean;
}>;

export type MachineDaemonTransferListenerClass =
    | 'loopback_http'
    | 'tailscale_serve_https';

export type MachineDaemonTransferState = Readonly<{
    supported: Readonly<{
        import: boolean;
        export: boolean;
    }>;
    listenerClasses: Readonly<{
        loopback_http: MachineDaemonTransferListenerClassState;
        tailscale_serve_https: MachineDaemonTransferListenerState;
    }>;
    lifecycle: Readonly<{
        mode: 'lazy_idle_shutdown';
        version: number;
    }>;
}>;

type MachineDaemonTransferListenerState = MachineDaemonTransferListenerClassState;

export type MachineDaemonTransferDirectPeerDiagnostics = Readonly<{
    route: TransferRouteViabilityRecord;
    state: 'unknown' | 'unconfigured' | 'configured_inactive' | 'active';
    configuredListenerClasses: readonly MachineDaemonTransferListenerClass[];
    activeListenerClasses: readonly MachineDaemonTransferListenerClass[];
    activeRouteKinds: readonly DirectPeerRouteKind[];
    inactiveListenerClasses: readonly MachineDaemonTransferListenerClass[];
    unavailableListenerClasses: readonly MachineDaemonTransferListenerClass[];
}>;

const TRANSFER_LISTENER_CLASS_ORDER: readonly MachineDaemonTransferListenerClass[] = [
    'loopback_http',
    'tailscale_serve_https',
] as const;

function readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readListenerState(value: unknown): MachineDaemonTransferListenerState | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    const enabled = readBoolean(candidate.enabled);
    const configured = readBoolean(candidate.configured);
    const active = readBoolean(candidate.active);
    if (enabled === null || configured === null || active === null) {
        return null;
    }
    const available = readBoolean(candidate.available);
    return {
        enabled,
        configured,
        active,
        ...(available === null ? {} : { available }),
    };
}

function hasConfiguredTransferListener(listenerClasses: MachineDaemonTransferState['listenerClasses']): boolean {
    return Object.values(listenerClasses).some((listener) => listener.enabled && listener.configured);
}

function hasActiveTransferListener(listenerClasses: MachineDaemonTransferState['listenerClasses']): boolean {
    return Object.values(listenerClasses).some((listener) => listener.enabled && listener.configured && listener.active && listener.available !== false);
}

function hasSupportedTransfer(supported: MachineDaemonTransferState['supported']): boolean {
    return supported.import && supported.export;
}

function resolveConfiguredListenerClasses(
    listenerClasses: MachineDaemonTransferState['listenerClasses'],
): MachineDaemonTransferListenerClass[] {
    return TRANSFER_LISTENER_CLASS_ORDER.filter((listenerClass) => {
        const listener = listenerClasses[listenerClass];
        return listener.enabled && listener.configured;
    });
}

function resolveActiveListenerClasses(
    listenerClasses: MachineDaemonTransferState['listenerClasses'],
): MachineDaemonTransferListenerClass[] {
    return TRANSFER_LISTENER_CLASS_ORDER.filter((listenerClass) => {
        const listener = listenerClasses[listenerClass];
        return listener.enabled && listener.configured && listener.active && listener.available !== false;
    });
}

function resolveInactiveListenerClasses(
    listenerClasses: MachineDaemonTransferState['listenerClasses'],
): MachineDaemonTransferListenerClass[] {
    return TRANSFER_LISTENER_CLASS_ORDER.filter((listenerClass) => {
        const listener = listenerClasses[listenerClass];
        return listener.enabled && listener.configured && !listener.active && listener.available !== false;
    });
}

function resolveUnavailableListenerClasses(
    listenerClasses: MachineDaemonTransferState['listenerClasses'],
): MachineDaemonTransferListenerClass[] {
    return TRANSFER_LISTENER_CLASS_ORDER.filter((listenerClass) => {
        const listener = listenerClasses[listenerClass];
        return listener.enabled && listener.configured && listener.available === false;
    });
}

function resolveActiveRouteKinds(
    activeListenerClasses: readonly MachineDaemonTransferListenerClass[],
): DirectPeerRouteKind[] {
    const routeKinds: DirectPeerRouteKind[] = [];
    for (const listenerClass of activeListenerClasses) {
        const routeKind = resolvePeerRouteKindForEndpointMechanism(listenerClass);
        if (routeKind !== 'server_relay' && !routeKinds.includes(routeKind)) {
            routeKinds.push(routeKind);
        }
    }
    return routeKinds;
}

export function readMachineDaemonTransferState(input: Readonly<{
    daemonState?: unknown | null;
}> | null | undefined): MachineDaemonTransferState | null {
    const daemonState = input?.daemonState;
    if (!daemonState || typeof daemonState !== 'object') {
        return null;
    }
    const transfer = (daemonState as Record<string, unknown>).transfer;
    if (!transfer || typeof transfer !== 'object') {
        return null;
    }

    const supported = (transfer as { supported?: unknown }).supported;
    const listenerClasses = (transfer as { listenerClasses?: unknown }).listenerClasses;
    const lifecycle = (transfer as { lifecycle?: unknown }).lifecycle;
    if (!supported || typeof supported !== 'object' || !listenerClasses || typeof listenerClasses !== 'object' || !lifecycle || typeof lifecycle !== 'object') {
        return null;
    }

    const supportedImport = readBoolean((supported as Record<string, unknown>).import);
    const supportedExport = readBoolean((supported as Record<string, unknown>).export);
    const lifecycleMode = (lifecycle as Record<string, unknown>).mode;
    const lifecycleVersion = readPositiveInteger((lifecycle as Record<string, unknown>).version);
    const loopbackHttp = readListenerState((listenerClasses as Record<string, unknown>).loopback_http);
    const tailscaleServeHttps = readListenerState((listenerClasses as Record<string, unknown>).tailscale_serve_https);

    if (
        supportedImport === null
        || supportedExport === null
        || lifecycleMode !== 'lazy_idle_shutdown'
        || lifecycleVersion === null
        || !loopbackHttp
        || !tailscaleServeHttps
    ) {
        return null;
    }

    return {
        supported: {
            import: supportedImport,
            export: supportedExport,
        },
        listenerClasses: {
            loopback_http: loopbackHttp,
            tailscale_serve_https: tailscaleServeHttps,
        },
        lifecycle: {
            mode: 'lazy_idle_shutdown',
            version: lifecycleVersion,
        },
    };
}

export function resolveMachineDaemonTransferDirectPeerRoute(
    input: Readonly<{
        daemonState?: unknown | null;
    }> | null | undefined,
): TransferRouteViabilityRecord {
    return resolveMachineDaemonTransferDirectPeerDiagnostics(input).route;
}

export function resolveMachineDaemonTransferDirectPeerDiagnostics(
    input: Readonly<{
        daemonState?: unknown | null;
    }> | null | undefined,
): MachineDaemonTransferDirectPeerDiagnostics {
    const transferState = readMachineDaemonTransferState(input);
    if (!transferState) {
        return {
            route: { status: 'unknown' },
            state: 'unknown',
            configuredListenerClasses: [],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: [],
            unavailableListenerClasses: [],
        };
    }

    const configuredListenerClasses = resolveConfiguredListenerClasses(transferState.listenerClasses);
    const activeListenerClasses = resolveActiveListenerClasses(transferState.listenerClasses);
    const activeRouteKinds = resolveActiveRouteKinds(activeListenerClasses);
    const inactiveListenerClasses = resolveInactiveListenerClasses(transferState.listenerClasses);
    const unavailableListenerClasses = resolveUnavailableListenerClasses(transferState.listenerClasses);

    if (!hasSupportedTransfer(transferState.supported)) {
        return {
            route: {
                status: 'unavailable',
                checkedAt: 0,
                expiresAt: 0,
                failureReason: 'daemon_transfer_listener_unconfigured',
            },
            state: 'unconfigured',
            configuredListenerClasses: [],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: [],
            unavailableListenerClasses: [],
        };
    }

    if (!hasConfiguredTransferListener(transferState.listenerClasses)) {
        return {
            route: {
                status: 'unavailable',
                checkedAt: 0,
                expiresAt: 0,
                failureReason: 'daemon_transfer_listener_unconfigured',
            },
            state: 'unconfigured',
            configuredListenerClasses,
            activeListenerClasses,
            activeRouteKinds,
            inactiveListenerClasses,
            unavailableListenerClasses,
        };
    }

    if (hasActiveTransferListener(transferState.listenerClasses)) {
        return {
            route: {
                status: 'viable',
                checkedAt: 0,
                expiresAt: Number.MAX_SAFE_INTEGER,
            },
            state: 'active',
            configuredListenerClasses,
            activeListenerClasses,
            activeRouteKinds,
            inactiveListenerClasses,
            unavailableListenerClasses,
        };
    }

    return {
        route: { status: 'unknown' },
        state: 'configured_inactive',
        configuredListenerClasses,
        activeListenerClasses,
        activeRouteKinds,
        inactiveListenerClasses,
        unavailableListenerClasses,
    };
}
