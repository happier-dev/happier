import type {
    HostTerminalOrchestration,
    HostTerminalProcessService,
    HostTerminalProjectionService,
    HostTerminalTranscriptFollowService,
} from './contract';

import { createTerminalRuntimeInputTriggerService } from './inputTrigger';
import {
    createTerminalRuntimeProcessService,
    type TerminalRuntimeExecutableGrantRegistrar,
    type TerminalRuntimeExecutableGrantVerifier,
} from './launchProcess';
import { createTerminalRuntimeSwitchHandlerService } from './switchHandler';

type TerminalHostMessageQueue = Parameters<typeof createTerminalRuntimeInputTriggerService>[0]['messageQueue'];
type TerminalHostSession = Readonly<{
    rpcHandlerManager?: Readonly<{
        registerHandler(method: 'switch', handler: (request: unknown) => Promise<boolean>): void;
    }>;
}>;

export function createTerminalRuntimeHostOrchestration(params: Readonly<{
    messageQueue?: TerminalHostMessageQueue | null;
    session: TerminalHostSession;
    process?: HostTerminalProcessService;
    projection?: HostTerminalProjectionService;
    transcriptFollow?: HostTerminalTranscriptFollowService;
    verifyExecutableGrant?: TerminalRuntimeExecutableGrantVerifier;
    registerExecutableGrant?: TerminalRuntimeExecutableGrantRegistrar;
}>): HostTerminalOrchestration | null {
    const registerHandler = params.session.rpcHandlerManager?.registerHandler?.bind(params.session.rpcHandlerManager);
    if (!params.messageQueue || !registerHandler) {
        return null;
    }
    const process = params.process
        ?? (params.verifyExecutableGrant
            ? createTerminalRuntimeProcessService({
                verifyExecutableGrant: params.verifyExecutableGrant,
                registerExecutableGrant: params.registerExecutableGrant,
            })
            : null);
    if (!process) {
        return null;
    }
    if (!params.projection) {
        return null;
    }

    return Object.freeze({
        input: createTerminalRuntimeInputTriggerService({ messageQueue: params.messageQueue }),
        switching: createTerminalRuntimeSwitchHandlerService({ registerHandler }),
        process,
        projection: params.projection,
        ...(params.transcriptFollow
            ? { transcriptFollow: params.transcriptFollow }
            : {}),
    });
}
