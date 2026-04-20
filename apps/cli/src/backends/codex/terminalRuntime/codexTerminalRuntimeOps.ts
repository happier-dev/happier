import type { TerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';

import {
    launchCodexTerminalRuntime,
    type CodexTerminalRuntimeLaunchResult,
} from './launchTerminalRuntime';
import { resolveCodexTerminalRuntimeTranscriptBinding } from './resolveTerminalTranscriptBinding';

export type CodexTerminalRuntimeLaunchParams = Parameters<typeof launchCodexTerminalRuntime>[0];
export type CodexTerminalRuntimeBindTranscriptParams = Readonly<{
    activeServerDir: string;
    candidateFilePath: string;
    codexHome: string | null;
    remoteSessionId: string | null;
    sessionMetaId: string | null;
}>;

export const codexTerminalRuntimeOps: TerminalRuntimeOps<
    CodexTerminalRuntimeLaunchParams,
    CodexTerminalRuntimeLaunchResult,
    never,
    never,
    CodexTerminalRuntimeBindTranscriptParams
> = {
    launch: async (params): Promise<CodexTerminalRuntimeLaunchResult> => await launchCodexTerminalRuntime(params),
    bindTranscript: (params) =>
        resolveCodexTerminalRuntimeTranscriptBinding({
            activeServerDir: params.activeServerDir,
            candidateFilePath: params.candidateFilePath,
            codexHome: params.codexHome,
            remoteSessionId: params.remoteSessionId,
            sessionMetaId: params.sessionMetaId,
        }),
};
