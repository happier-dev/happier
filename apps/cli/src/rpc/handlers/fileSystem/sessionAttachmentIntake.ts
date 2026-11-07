import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { FilesystemEffectChannel } from './filesystemEffectChannel';
import type { FilesystemEffectConfiguration } from './filesystemEffectOperation';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { TransferSessionStore } from '@happier-dev/transfers/node';

/** Closed Session host composition, never supplied by an RPC caller. */
export type SessionAttachmentRequester = Readonly<{
    sessionId: string;
    homeServerIdentityId: string;
    identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
}>;

export type SessionAttachmentNativeRuntime = Readonly<{
    requester: SessionAttachmentRequester;
    workingDirectory: string;
    prepareFilesystemEffect(configuration: FilesystemEffectConfiguration, signal?: AbortSignal): Promise<FilesystemEffectChannel>;
}>;

/** This transport consumes the receiver's admission; native transfer handlers
 * remain the sole owners of paths, upload state and issued handles. */
export function createSessionAttachmentNativeRegistrar(input: Readonly<{
    delegate: RpcHandlerRegistrar;
    readRuntime?: () => SessionAttachmentNativeRuntime | null | undefined;
    configuration: Pick<FilesystemEffectConfiguration, 'sessionAttachment' | 'sessionRpcTransferMaxBytes'>;
    store: TransferSessionStore;
}>) {
    let channel: Promise<FilesystemEffectChannel> | undefined;
    const registrar: RpcHandlerRegistrar = {
        registerHandler(method, localHandler) {
            input.delegate.registerHandler(method, async (request, context) => {
                const runtime = input.readRuntime?.();
                if (!channel && !runtime) return await localHandler(request, context);
                context?.signal.throwIfAborted();
                if (!channel && runtime) channel = runtime.prepareFilesystemEffect({ ...input.configuration,
                    workingDirectory: runtime.workingDirectory,
                    accessPolicy: { kind: 'restrictedRoots', roots: [runtime.workingDirectory] },
                }).catch(error => {
                    channel = undefined;
                    throw error;
                });
                // The closed host-selected worker emits this private projection.
                // It is not caller input and grants no path-based read authority.
                const result = await (await channel!).request({ kind: 'rpc', method, input: request }) as Readonly<{
                    response: Awaited<ReturnType<typeof localHandler>>;
                    issuedAttachment?: NonNullable<ReturnType<TransferSessionStore['getIssuedAttachment']>>;
                }>;
                const issued = result.issuedAttachment;
                if (issued) input.store.issueAttachment({ ...issued, uploadId: issued.handle.id, sessionId: issued.handle.sessionId });
                return result.response;
            });
        },
    };
    return { registrar, async dispose() {
        // A failed open already refused its RPC and has no retained channel.
        await channel?.then(opened => opened.dispose(), () => undefined);
    } };
}
