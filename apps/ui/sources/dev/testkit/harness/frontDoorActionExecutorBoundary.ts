import type * as FrontDoor from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Substitute Metro's module loader only; the real factory and Action front door still execute. */
export function createFrontDoorActionExecuteForVitest(
    original: typeof FrontDoor,
): typeof FrontDoor.createFrontDoorActionExecute {
    return (executor, options) => {
        if (executor) return original.createFrontDoorActionExecute(executor, options);
        let resolved: FrontDoor.FrontDoorActionExecute | null = null;
        const resolve = async () => {
            resolved ??= original.createFrontDoorActionExecute(
                (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor(options),
            );
            return resolved;
        };
        const execute: FrontDoor.FrontDoorActionExecute = Object.assign(
            async (...args: Parameters<FrontDoor.FrontDoorActionExecute>) => (await resolve())(...args),
            {
                prepare: async (...args: Parameters<FrontDoor.FrontDoorActionExecute['prepare']>) => (await resolve()).prepare(...args),
            },
        );
        return execute;
    };
}
