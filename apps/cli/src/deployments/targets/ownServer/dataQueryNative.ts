import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

export type OwnServerDataQueryNative = Readonly<{
    run(input: Readonly<{ argv: readonly string[]; stdin: Uint8Array; env: Readonly<Record<string, string>>;
        signal: AbortSignal }>): Promise<Readonly<{ exitCode: number; stdout: string; stdoutTruncated: boolean; stderr?: string }>>;
}>;

const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Passwords, SQL and parameters cross Docker only through supervised stdin.
 * The mounted service owner supplies the exact engine/container and effect keys. */
export async function withOwnServerDataQueryNativeForHost<T>(input: Readonly<{
    handle: Pick<ProjectManagedServiceHandle, 'readNativeEffectKeys' | 'readNativeDocker'>;
    containerId: string; operationId: string; signal: AbortSignal; allowTruncatedStdout?: true;
}>, effect: (native: OwnServerDataQueryNative) => Promise<T>): Promise<T> {
    const keys = await input.handle.readNativeEffectKeys?.({ signal: input.signal });
    if (!keys || !input.handle.readNativeDocker) return refuse('service_admission_unavailable');
    return machineNativeEffectAdmission.run({ operation: { operationId: input.operationId, kind: 'dataQuery', signal: input.signal }, keys },
        async context => {
            const docker = await input.handle.readNativeDocker!({ signal: input.signal });
            const native: OwnServerDataQueryNative = { async run(request) {
                request.signal.throwIfAborted();
                const script = [...Object.entries(request.env).map(([key, value]) => `export ${quote(`${key}=${value}`)}`),
                    `printf %s ${quote(Buffer.from(request.stdin).toString('utf8'))} | ${request.argv.map(quote).join(' ')}`].join('\n');
                const result = await machineNativeEffectAdmission.runStage(context, () => docker.run([
                    'exec', '-i', input.containerId, 'sh', '-s',
                ], context.operation.signal, Buffer.from(script),
                input.allowTruncatedStdout ? { allowTruncatedStdout: true } : undefined));
                return { ...result, stdoutTruncated: result.stdoutTruncated ?? false };
            } };
            return effect(native);
        });
}
