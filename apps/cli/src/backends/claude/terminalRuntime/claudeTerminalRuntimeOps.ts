import type { TerminalRuntimeOps } from '@/agent/terminalRuntime/providers/types';

import { launchClaudeTerminalSession, type LauncherResult } from '../runtime/terminal/launcher';

export type ClaudeTerminalRuntimeLaunchParams = Readonly<{
    session: Parameters<typeof launchClaudeTerminalSession>[0];
    options?: Parameters<typeof launchClaudeTerminalSession>[1];
}>;

export const claudeTerminalRuntimeOps: TerminalRuntimeOps<ClaudeTerminalRuntimeLaunchParams, LauncherResult> = {
    launch: async (params): Promise<LauncherResult> => await launchClaudeTerminalSession(params.session, params.options),
};
