import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

export type MachineDaemonTransferListenerClassState = Readonly<{
    enabled: boolean;
    configured: boolean;
    active: boolean;
    available?: boolean;
}>;

export type MachineDaemonTransferState = Readonly<{
    supported: Readonly<{
        import: boolean;
        export: boolean;
    }>;
    listenerClasses: Readonly<{
        loopback_http: MachineDaemonTransferListenerClassState;
        lan_http: MachineDaemonTransferListenerState;
        tailscale_serve_https: MachineDaemonTransferListenerState;
    }>;
    lifecycle: Readonly<{
        mode: 'lazy_idle_shutdown';
        version: number;
    }>;
}>;

type MachineDaemonTransferListenerState = MachineDaemonTransferListenerClassState;

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
    const lanHttp = readListenerState((listenerClasses as Record<string, unknown>).lan_http);
    const tailscaleServeHttps = readListenerState((listenerClasses as Record<string, unknown>).tailscale_serve_https);

    if (
        supportedImport === null
        || supportedExport === null
        || lifecycleMode !== 'lazy_idle_shutdown'
        || lifecycleVersion === null
        || !loopbackHttp
        || !lanHttp
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
            lan_http: lanHttp,
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
    const transferState = readMachineDaemonTransferState(input);
    if (!transferState) {
        return { status: 'unknown' };
    }

    if (!hasConfiguredTransferListener(transferState.listenerClasses)) {
        return {
            status: 'unavailable',
            checkedAt: 0,
            expiresAt: 0,
            failureReason: 'daemon_transfer_listener_unconfigured',
        };
    }

    if (hasActiveTransferListener(transferState.listenerClasses)) {
        return {
            status: 'viable',
            checkedAt: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
        };
    }

    return { status: 'unknown' };
}
