export type HappierWebRuntimeConfig = Readonly<{
    serverUrl?: string;
    serverContext?: string;
    organizationPolicyJson?: string;
    organizationPolicyError?: Readonly<{ path: string; code: string }>;
    firstOpenCandidate?: 'overlay' | 'in-app';
    // Set at container start by the generic web image (docker/webapp-runtime.sh); omitted when unset.
    posthogKey?: string;
    posthogHost?: string;
    sentryDsn?: string;
    sentryEnvironment?: string;
}>;

type WebRuntimeConfigStringKey = 'serverUrl' | 'serverContext' | 'posthogKey' | 'posthogHost' | 'sentryDsn' | 'sentryEnvironment';

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

/** Trimmed value, or '' when the web runtime config does not set it as a string. */
export function readWebRuntimeConfigString(key: WebRuntimeConfigStringKey): string {
    const raw: unknown = readWebRuntimeConfig()?.[key];
    return typeof raw === 'string' ? raw.trim() : '';
}

export function readWebRuntimeConfigServerUrl(): string {
    return readWebRuntimeConfigString('serverUrl');
}

export function readWebRuntimeConfigServerContext(): string {
    return readWebRuntimeConfigString('serverContext');
}

export function readWebRuntimeFirstOpenCandidate(): HappierWebRuntimeConfig['firstOpenCandidate'] {
    const value = readWebRuntimeConfig()?.firstOpenCandidate;
    return value === 'overlay' || value === 'in-app' ? value : undefined;
}
