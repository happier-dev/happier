import type {
    TerminalRuntimeHostOrchestrationV1,
    TerminalRuntimeProcessServiceV1,
    TerminalRuntimeProjectionHostServiceV1,
    TerminalRuntimeTranscriptBindingHostServiceV1,
} from '@happier-dev/agents';

import { createTerminalRuntimeInputTriggerService } from './inputTrigger';
import {
    createTerminalRuntimeProcessService,
    type TerminalRuntimeExecutableGrantRegistrar,
    type TerminalRuntimeExecutableGrantVerifier,
} from './launchProcess';
import { createTerminalRuntimeSwitchHandlerService } from './switchHandler';
import { createTerminalRuntimeTranscriptBindingHostService } from './transcriptBinding';

type TerminalHostMessageQueue = Parameters<typeof createTerminalRuntimeInputTriggerService>[0]['messageQueue'];
type TerminalHostSession = Readonly<{
    rpcHandlerManager?: Readonly<{
        registerHandler(method: 'switch', handler: (request: unknown) => Promise<boolean>): void;
    }>;
}>;

export function createTerminalRuntimeHostOrchestration(params: Readonly<{
    messageQueue?: TerminalHostMessageQueue | null;
    session: TerminalHostSession;
    process?: TerminalRuntimeProcessServiceV1;
    projection?: TerminalRuntimeProjectionHostServiceV1;
    transcripts?: TerminalRuntimeTranscriptBindingHostServiceV1;
    verifyExecutableGrant?: TerminalRuntimeExecutableGrantVerifier;
    registerExecutableGrant?: TerminalRuntimeExecutableGrantRegistrar;
}>): TerminalRuntimeHostOrchestrationV1 | null {
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
        transcripts: params.transcripts ?? createTerminalRuntimeTranscriptBindingHostService(),
        projection: params.projection,
    });
}
