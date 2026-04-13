import type { TerminalRuntimeOps } from '@/backends/terminalRuntime/types';

import { codexLocalLauncher, type CodexLauncherResult } from '../codexLocalLauncher';
import { resolveCodexTerminalRuntimeTranscriptBinding } from './resolveCodexTerminalRuntimeTranscriptBinding';

export type CodexTerminalRuntimeLaunchParams = Parameters<typeof codexLocalLauncher>[0];
export type CodexTerminalRuntimeBindTranscriptParams = Readonly<{
    activeServerDir: string;
    candidateFilePath: string;
    codexHome: string | null;
    remoteSessionId: string | null;
    sessionMetaId: string | null;
}>;

export const codexTerminalRuntimeOps: TerminalRuntimeOps<
    CodexTerminalRuntimeLaunchParams,
    CodexLauncherResult,
    never,
    never,
    CodexTerminalRuntimeBindTranscriptParams
> = {
    launch: async (params): Promise<CodexLauncherResult> => await codexLocalLauncher(params),
    bindTranscript: (params) =>
        resolveCodexTerminalRuntimeTranscriptBinding({
            activeServerDir: params.activeServerDir,
            candidateFilePath: params.candidateFilePath,
            codexHome: params.codexHome,
            remoteSessionId: params.remoteSessionId,
            sessionMetaId: params.sessionMetaId,
        }),
};
