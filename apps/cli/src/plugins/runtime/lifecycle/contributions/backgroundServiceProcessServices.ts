import { PluginError, type JsonValue, type PluginDiagnosticData, type PluginServiceId, type PluginServices } from '@happier-dev/plugin-sdk';

import { createPluginInvocationServicesFactory } from '../../invocation/services/factory';
import { createPluginInvocationServiceBinding, createUnavailablePluginServices, PLUGIN_SERVICE_IDS } from '../../invocation/services/unavailable';
import type { PluginInvocationServiceBinding, PluginInvocationServicesSeed } from '../../invocation/services/types';
import { resolvePluginPathWithinRoots } from '../../invocation/services/filesystem';
import type { PluginHttpRuntimeAdapter, StablePluginHttpHost } from '../../fetch/service';
import type { PluginInvocationServicesFactoryParams } from '../../invocation/services/unavailable';
import type { PluginInvocationLogLevel } from '../../invocation/services/logger';
import { createGlobalFetchRuntime } from '../../fetch/globalFetchRuntime';

import { BACKGROUND_SERVICE_PROCESS_LOCAL_SERVICE_IDS, BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS } from './backgroundServiceProcessPolicy';
export { BACKGROUND_SERVICE_PROCESS_LOCAL_SERVICE_IDS, BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS } from './backgroundServiceProcessPolicy';

/** The daemon copies its admitted policy; child construction does not interpret HostAccess. */
export type BackgroundServiceProcessLocalPolicy = Readonly<{
    binding: Pick<PluginInvocationServiceBinding,
        'id' | 'occurrenceId' | 'availability' | 'unavailableDiagnostics'
        | 'filesystemScopes' | 'filesystemRequestIds'
        | 'processExecutables' | 'processEnvKeys' | 'processRequestIds' | 'environmentRequestIds'
        | 'networkOrigins' | 'networkHostSuffixes' | 'networkRequestIds' | 'networkScopes'
        | 'networkClientOrigins' | 'networkClientHostSuffixes' | 'networkClientRequestIds' | 'networkClientScopes'>;
    filesystemRoots?: Readonly<{ pluginData: string; workspace?: string; projects: readonly (readonly [string, string])[] }>;
    environment?: Readonly<Record<string, string>>;
}>;

/** Daemon-bound policy only. Physical HTTP connections and child Exec custody stay local. */
export type BackgroundServiceProcessLogInput = Readonly<{
    level: PluginInvocationLogLevel;
    message?: string;
    fields?: Readonly<Record<string, JsonValue>>;
    diagnostic?: PluginDiagnosticData | Readonly<Record<string, JsonValue>>;
}>;

export type BackgroundServiceProcessLocalHost = Readonly<{
    writeLog(input: BackgroundServiceProcessLogInput): Promise<void>;
    resolveExecutable?: NonNullable<PluginInvocationServicesFactoryParams['exec']>['resolveExecutable'];
    systemTools?: NonNullable<PluginInvocationServicesFactoryParams['exec']>['systemTools'];
    agentCli?: NonNullable<PluginInvocationServicesFactoryParams['exec']>['agentCli'];
    assertLaunchCurrent?: NonNullable<PluginInvocationServicesFactoryParams['exec']>['assertLaunchCurrent'];
    http?: Readonly<{
        request(input: Parameters<PluginServices['http']['request']>[0], options: Parameters<PluginServices['http']['request']>[1], adapter: PluginHttpRuntimeAdapter): ReturnType<PluginServices['http']['request']>;
        openWebSocket(input: Parameters<PluginServices['http']['openWebSocket']>[0], options: Parameters<PluginServices['http']['openWebSocket']>[1], adapter: PluginHttpRuntimeAdapter): ReturnType<PluginServices['http']['openWebSocket']>;
    }>;
}>;

export type PreparedBackgroundServiceProcessLocalServices = Readonly<{
    localPolicy: BackgroundServiceProcessLocalPolicy;
    services: Readonly<Record<string, unknown>> & Readonly<{ __backgroundServiceProcessLocal: BackgroundServiceProcessLocalHost }>;
}>;

/** An Agent operation's callable graph must retire before its containing run settles. */
export type PreparedBackgroundServiceProcessOperationServices = PreparedBackgroundServiceProcessLocalServices & Readonly<{
    dispose(): Promise<void>;
}>;

function readIdentity(value: unknown): Readonly<{ id: string; version: string }> {
    if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !('version' in value) || typeof value.version !== 'string') {
        throw new PluginError({ code: 'background_service_process_context_invalid', message: 'Background service has no admitted plugin identity' });
    }
    return { id: value.id, version: value.version };
}

/** Build the ordinary service factory locally, then overlay the daemon-owned proxy roots. */
export function createBackgroundServiceProcessServices(params: Readonly<{
    metadata: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    clientServices: Readonly<Record<string, unknown>>;
    localPolicy?: BackgroundServiceProcessLocalPolicy;
}>): Readonly<{ services: PluginServices & Readonly<Record<string, unknown>>; dispose(): Promise<void> }> {
    const unavailable = createUnavailablePluginServices();
    const lifetime = new AbortController();
    const abort = () => lifetime.abort();
    if (params.signal.aborted) abort();
    else params.signal.addEventListener('abort', abort, { once: true });
    let local = unavailable;
    const policy = params.localPolicy;
    if (policy) {
        const plugin = readIdentity(params.metadata.plugin);
        const contribution = params.metadata.contribution;
        if (typeof contribution !== 'object' || contribution === null || !('id' in contribution) || typeof contribution.id !== 'string' || !('qualifiedId' in contribution) || typeof contribution.qualifiedId !== 'string') {
            throw new PluginError({ code: 'background_service_process_context_invalid', message: 'Background service has no admitted contribution identity' });
        }
        const roots = policy.filesystemRoots ? {
            ...policy.filesystemRoots, projects: new Map(policy.filesystemRoots.projects),
        } : undefined;
        const seed: PluginInvocationServicesSeed = {
            plugin,
            contribution: { id: contribution.id, qualifiedId: contribution.qualifiedId },
            occurrenceId: policy.binding.occurrenceId,
            correlationId: typeof params.metadata.invocationId === 'string' ? params.metadata.invocationId : contribution.qualifiedId,
            surface: 'background', signal: lifetime.signal,
            isOccurrenceCurrent: () => !lifetime.signal.aborted,
        };
        const base = createPluginInvocationServiceBinding(policy.binding.occurrenceId, policy.binding.id);
        const binding: PluginInvocationServiceBinding = {
            ...base, ...policy.binding,
            availability: Object.fromEntries(PLUGIN_SERVICE_IDS.map((serviceId) => [serviceId,
                BACKGROUND_SERVICE_PROCESS_LOCAL_SERVICE_IDS.some((id) => id === serviceId) ? policy.binding.availability[serviceId] : 'unavailable',
            ])) as PluginInvocationServiceBinding['availability'],
        };
        const privateHost = params.clientServices.__backgroundServiceProcessLocal as BackgroundServiceProcessLocalHost | undefined;
        if (!privateHost?.writeLog) {
            throw new PluginError({ code: 'background_service_process_logger_unavailable', message: 'Daemon invocation log redaction is unavailable' });
        }
        const writeLog = (input: BackgroundServiceProcessLogInput): void => { void privateHost.writeLog(input).catch(() => {}); };
        // Raw operands reach the invocation's enrolled-value redactor before any clipping.
        const localLogger: PluginServices['logger'] = {
            debug: (message, fields) => writeLog({ level: 'debug', message, fields }),
            info: (message, fields) => writeLog({ level: 'info', message, fields }),
            warn: (message, fields) => writeLog({ level: 'warn', message, fields }),
            error: (message, fields) => writeLog({ level: 'error', message, fields }),
            diagnostic: (diagnostic) => writeLog({ level: 'diagnostic', diagnostic }),
        };
        const transport = createGlobalFetchRuntime();
        const http: StablePluginHttpHost | undefined = privateHost?.http ? {
            bind: () => ({
                request: (input, options) => privateHost.http!.request(input, options, transport),
                openWebSocket: (input, options) => privateHost.http!.openWebSocket(input, options, transport),
            }),
        } : undefined;
        const factory = createPluginInvocationServicesFactory({
            loggerSink: { write: writeLog },
            resolveLogger: () => localLogger,
            ...(roots ? { filesystemRoots: roots } : {}),
            ...(http ? { http } : {}),
            ...(privateHost?.resolveExecutable ? { exec: {
                posixProcessGroup: 'inherit',
                resolveExecutable: privateHost.resolveExecutable,
                resolvePath: async (path) => {
                    if (!roots) throw new PluginError({ code: 'plugin_fs_root_unavailable', message: 'Filesystem roots are unavailable' });
                    return resolvePluginPathWithinRoots(roots, path);
                },
                ...(policy.environment ? { environment: policy.environment } : {}),
                ...(privateHost.systemTools ? { systemTools: privateHost.systemTools } : {}),
                ...(privateHost.agentCli ? { agentCli: privateHost.agentCli } : {}),
                ...(privateHost.assertLaunchCurrent ? { assertLaunchCurrent: privateHost.assertLaunchCurrent } : {}),
            } } : {}),
        });
        local = factory(seed, binding);
    }
    const suppliedAvailability = params.clientServices.__serviceAvailability;
    const readSuppliedAvailability = (serviceId: PluginServiceId): ReturnType<PluginServices['availability']> => {
        const result: unknown = typeof suppliedAvailability === 'object' && suppliedAvailability !== null ? Reflect.get(suppliedAvailability, serviceId) : undefined;
        if (typeof result === 'object' && result !== null && 'status' in result && result.status === 'available') return { status: 'available' };
        if (typeof result === 'object' && result !== null && 'status' in result && (result.status === 'unavailable' || result.status === 'denied') && 'code' in result && typeof result.code === 'string') return { status: result.status, code: result.code };
        return unavailable.availability(serviceId);
    };
    const proxied = Object.fromEntries(BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS.flatMap((serviceId) => (
        Object.hasOwn(params.clientServices, serviceId) && readSuppliedAvailability(serviceId).status === 'available' ? [[serviceId, params.clientServices[serviceId]]] : []
    )));
    const availability: PluginServices['availability'] = (serviceId: PluginServiceId) => {
        if (BACKGROUND_SERVICE_PROCESS_LOCAL_SERVICE_IDS.some((id) => id === serviceId)) return local.availability(serviceId);
        if (BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS.some((id) => id === serviceId) && Object.hasOwn(params.clientServices, serviceId)) return readSuppliedAvailability(serviceId);
        return unavailable.availability(serviceId);
    };
    // Extra roots are private daemon-admitted host services (for example Memory), not SDK service grants.
    const extras = Object.fromEntries(Object.entries(params.clientServices).filter(([key]) => key !== '__serviceAvailability' && key !== '__backgroundServiceProcessLocal' && !PLUGIN_SERVICE_IDS.some((id) => id === key) && key !== 'availability'));
    return {
        services: Object.freeze({ ...unavailable, ...extras, ...Object.fromEntries(BACKGROUND_SERVICE_PROCESS_LOCAL_SERVICE_IDS.map((id) => [id, local[id]])), ...proxied, availability }) as PluginServices & Readonly<Record<string, unknown>>,
        async dispose() { params.signal.removeEventListener('abort', abort); lifetime.abort(); },
    };
}
