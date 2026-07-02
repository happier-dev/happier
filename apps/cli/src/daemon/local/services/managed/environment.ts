export const LOCAL_SERVICE_ENV = Object.freeze({
    PORT: 'PORT',
    HOST: 'HOST',
    PRIVATE_URL: 'HAPPIER_URL',
    PREVIEW_URL: 'HAPPIER_PREVIEW_URL',
});

export type LocalServiceEnvironmentVariable = keyof typeof LOCAL_SERVICE_ENV | 'HAPPIER_URL' | 'HAPPIER_PREVIEW_URL';

function shouldInject(inject: readonly string[], key: string): boolean {
    return inject.includes(key);
}

export function buildLocalServiceLaunchEnvironment(input: Readonly<{
    baseEnv: Readonly<Record<string, string | undefined>>;
    host: string;
    port: number;
    privateUrl?: string;
    previewUrl?: string;
    inject: readonly string[];
}>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.baseEnv)) {
        if (value !== undefined) env[key] = value;
    }
    if (shouldInject(input.inject, LOCAL_SERVICE_ENV.PORT)) env[LOCAL_SERVICE_ENV.PORT] = String(input.port);
    if (shouldInject(input.inject, LOCAL_SERVICE_ENV.HOST)) env[LOCAL_SERVICE_ENV.HOST] = input.host;
    if (input.privateUrl && shouldInject(input.inject, LOCAL_SERVICE_ENV.PRIVATE_URL)) {
        env[LOCAL_SERVICE_ENV.PRIVATE_URL] = input.privateUrl;
    }
    if (input.previewUrl && shouldInject(input.inject, LOCAL_SERVICE_ENV.PREVIEW_URL)) {
        env[LOCAL_SERVICE_ENV.PREVIEW_URL] = input.previewUrl;
    }
    return env;
}

export type LocalServiceRuntimeAdapter = 'vite' | 'astro' | 'angular' | 'expo' | 'none';

export function buildRuntimePortArgs(input: Readonly<{
    adapter: LocalServiceRuntimeAdapter;
    host: string;
    port: number;
    expoLanMode: boolean;
}>): readonly string[] {
    if (input.adapter === 'none') return [];
    if (input.adapter === 'expo') {
        return input.expoLanMode
            ? ['--port', String(input.port)]
            : ['--port', String(input.port), '--host', input.host];
    }
    if (input.adapter === 'vite' || input.adapter === 'astro' || input.adapter === 'angular') {
        return ['--port', String(input.port), '--host', input.host, '--strictPort'];
    }
    return [];
}
