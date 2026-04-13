import type { TerminalRuntimeOps } from '@/backends/terminalRuntime/types';

import { claudeLocalLauncher, type LauncherResult } from '../claudeLocalLauncher';

export type ClaudeTerminalRuntimeLaunchParams = Readonly<{
    session: Parameters<typeof claudeLocalLauncher>[0];
    options?: Parameters<typeof claudeLocalLauncher>[1];
}>;

export const claudeTerminalRuntimeOps: TerminalRuntimeOps<ClaudeTerminalRuntimeLaunchParams, LauncherResult> = {
    launch: async (params): Promise<LauncherResult> => await claudeLocalLauncher(params.session, params.options),
};
