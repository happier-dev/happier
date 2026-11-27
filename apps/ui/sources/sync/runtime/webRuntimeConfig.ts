export type HappierWebRuntimeConfig = Readonly<{
    serverUrl?: string;
    posthogKey?: string;
    posthogHost?: string;
    sentryDsn?: string;
    sentryEnvironment?: string;
}>;

type RuntimeWindow = Window & {
    __HAPPIER_WEB_RUNTIME_CONFIG__?: HappierWebRuntimeConfig;
};

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function readWebRuntimeConfig(): HappierWebRuntimeConfig | null {
    if (!isWebRuntime()) return null;
    const config = (window as RuntimeWindow).__HAPPIER_WEB_RUNTIME_CONFIG__;
    if (!config || typeof config !== 'object') return null;
    return config;
}

/** Trimmed container-start value, or '' when the web runtime config does not set it. */
export function readWebRuntimeConfigString(key: keyof HappierWebRuntimeConfig): string {
    const raw: unknown = readWebRuntimeConfig()?.[key];
    return typeof raw === 'string' ? raw.trim() : '';
}

export function readWebRuntimeConfigServerUrl(): string {
    return readWebRuntimeConfigString('serverUrl');
}
