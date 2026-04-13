import type { TerminalRuntimeOps } from '@/backends/terminalRuntime/types';

import { waitForOhMyPiTerminalRuntimeBinding } from './waitForOhMyPiTerminalRuntimeBinding';

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
    bindTranscript: (params) =>
        waitForOhMyPiTerminalRuntimeBinding({
            cwd: params.cwd,
            env: params.env,
            terminalId: params.terminalId,
        }),
};
