import { randomBytes } from 'node:crypto';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { AgentNativeLaunchQualifier, ExecService, PluginExecSpawnRequest, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginJsonRpcClient } from '@happier-dev/plugin-sdk/exec/protocol-clients';

export const MUSE_MSP_LAUNCH = {
    args: ['serve'],
    env: { MUSE_NO_AUTO_UPDATE: '1' },
} as const;

export type MuseMspOpenOptions = Readonly<{
    exec: ExecService;
    launch: PluginExecSpawnRequest;
    signal?: AbortSignal;
    nativeLaunch?: AgentNativeLaunchQualifier;
    initialize?: Readonly<Record<string, JsonValue>>;
    onNotification?: Parameters<PluginJsonRpcClient['onNotification']>[0];
    onRequest?: Readonly<Record<string, Parameters<PluginJsonRpcClient['onRequest']>[1]>>;
}>;

export type MuseMsp = Readonly<{
    client: PluginJsonRpcClient;
    initializeResult: JsonValue;
    process: PluginProcessHandle;
    command(method: string, params: Readonly<Record<string, JsonValue>>, options?: {
        signal?: AbortSignal;
        onCommandId?(commandId: string): void;
    }): Promise<JsonValue>;
    wait(): Promise<PluginProcessResult>;
    dispose(): Promise<void>;
}>;

/** MSP requires UUIDv7 command identities; they are ephemeral native inputs. */
function createCommandId(): string {
    const bytes = randomBytes(16);
    bytes.writeUIntBE(Date.now(), 0, 6);
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hasSupportedEnvelope(value: JsonValue): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('schema' in value)) return false;
    const schema = value.schema;
    return Boolean(schema && typeof schema === 'object' && !Array.isArray(schema) && 'version' in schema && schema.version === 1);
}

/** Session, history and pre-Session catalog clients share this wire readiness owner. */
export async function initializeMuseMsp(
    client: Pick<PluginJsonRpcClient, 'request' | 'notify'>,
    options?: Readonly<{ initialize?: Readonly<Record<string, JsonValue>>; signal?: AbortSignal }>,
): Promise<JsonValue> {
    const result = await client.request('initialize', {
        ...options?.initialize,
        clientInfo: { name: 'happier_muse', version: '0.3.0' },
    }, { signal: options?.signal });
    if (!hasSupportedEnvelope(result)) {
        throw new PluginError({ code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message: 'Muse MSP returned an unsupported schema envelope version' });
    }
    await client.notify('initialized', {});
    return result;
}

export async function openMuseMsp(options: MuseMspOpenOptions): Promise<MuseMsp> {
    const handle = await options.exec.clients.spawn({ kind: 'jsonRpc', framing: 'jsonLines', launch: {
        ...options.launch,
        args: [...MUSE_MSP_LAUNCH.args, ...(options.launch.args ?? [])],
        env: { ...options.launch.env, ...MUSE_MSP_LAUNCH.env },
    } },
        { signal: options.signal, nativeLaunch: options.nativeLaunch });
    let initializeResult: JsonValue;
    try {
        if (options.onNotification) handle.client.onNotification(options.onNotification);
        for (const [method, listener] of Object.entries(options.onRequest ?? {})) handle.client.onRequest(method, listener);
        initializeResult = await initializeMuseMsp(handle.client, options);
    } catch (error) {
        await handle.dispose().catch(() => undefined);
        throw error;
    }
    return {
        client: handle.client,
        initializeResult,
        process: handle.process,
        command: (method, params, requestOptions) => {
            const commandId = createCommandId();
            requestOptions?.onCommandId?.(commandId);
            return handle.client.request(method, { ...params, commandId }, { signal: requestOptions?.signal });
        },
        wait: () => handle.wait(),
        async dispose() {
            try {
                await handle.process.closeStdin();
                await handle.wait();
            } finally { await handle.dispose(); }
        },
    };
}
