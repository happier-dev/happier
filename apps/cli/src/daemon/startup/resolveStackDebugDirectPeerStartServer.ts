import type {
    createDirectTransferServerLifecycle,
} from '@/machines/transfer/directTransferServerLifecycle';

type StartServer = NonNullable<
    Parameters<typeof createDirectTransferServerLifecycle>[0]['startServer']
>;

type StackDebugDirectPeerModule = Readonly<{
    startStackDebugDirectPeerTransferServer: StartServer;
}>;

export async function resolveStackDebugDirectPeerStartServer(input?: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    loadModule?: () => Promise<StackDebugDirectPeerModule>;
}>): Promise<StartServer | undefined> {
    const env = input?.env ?? process.env;
    if (env.HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT !== '1') {
        return undefined;
    }
    const module = await (
        input?.loadModule
        ?? (() => import('@/testkit/transfers/startStackDebugDirectPeerTransferServer'))
    )();
    return module.startStackDebugDirectPeerTransferServer;
}
