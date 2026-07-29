import type {
    HostTerminalSwitchHandlerService,
    HostTerminalSwitchRequest,
    HostTerminalSwitchTarget,
} from './contract';

type RpcSwitchRegistrar = Readonly<{
    registerHandler(
        method: 'switch',
        handler: (request: unknown) => Promise<boolean>,
    ): void;
}>;

function readSwitchTarget(request: unknown): HostTerminalSwitchTarget {
    const record = request && typeof request === 'object' && !Array.isArray(request)
        ? request as Record<string, unknown>
        : {};
    const to = typeof record.to === 'string' ? record.to.trim() : '';
    if (to === 'local') {
        return 'local';
    }
    if (to === 'remote') {
        return 'remote';
    }
    return 'unknown';
}

function sanitizeSwitchRequest(request: unknown): HostTerminalSwitchRequest {
    return Object.freeze({
        target: readSwitchTarget(request),
    });
}

export function createTerminalRuntimeSwitchHandlerService(params: Readonly<{
    registerHandler: RpcSwitchRegistrar['registerHandler'];
}>): HostTerminalSwitchHandlerService {
    let active = false;

    return Object.freeze({
        register(handler) {
            if (active) {
                throw new Error('Terminal runtime switch handler is already registered');
            }
            active = true;
            params.registerHandler('switch', async (request) => {
                if (!active) {
                    return false;
                }
                return await handler(sanitizeSwitchRequest(request));
            });
            return {
                unsubscribe() {
                    active = false;
                },
            };
        },
    });
}
