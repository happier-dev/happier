export type HappierWebRuntimeConfig = Readonly<{
    serverUrl?: string;
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

export function readWebRuntimeConfigServerUrl(): string {
    const raw = readWebRuntimeConfig()?.serverUrl;
    return typeof raw === 'string' ? raw.trim() : '';
}
