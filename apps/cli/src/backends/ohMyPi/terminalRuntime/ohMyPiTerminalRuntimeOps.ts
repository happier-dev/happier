import type { TerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';

import { waitForOhMyPiTerminalTranscriptBinding } from './waitForOhMyPiTerminalTranscriptBinding';

export type OhMyPiTerminalRuntimeBindTranscriptParams = Readonly<{
    cwd: string;
    env?: NodeJS.ProcessEnv;
    terminalId?: string | null;
}>;

export const ohMyPiTerminalRuntimeOps: TerminalRuntimeOps<
    never,
    never,
    never,
    never,
    OhMyPiTerminalRuntimeBindTranscriptParams
> = {
    resolveTranscriptBinding: (params) =>
        waitForOhMyPiTerminalTranscriptBinding({
            cwd: params.cwd,
            env: params.env,
            terminalId: params.terminalId,
        }),
};
