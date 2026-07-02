import { createTerminalBreadcrumbResolver } from '@/agent/runtime/terminal/breadcrumbs/createTerminalBreadcrumbResolver';
import { getTerminalId } from '@/agent/terminalRuntime/providers/getTerminalId';
import {
    OH_MY_PI_TERMINAL_BREADCRUMB_SUBDIR,
    OH_MY_PI_TERMINAL_SESSIONS_SUBDIR,
    canonicalizeOhMyPiTerminalRuntimePath,
    isOhMyPiTerminalRuntimeCwdMatch,
    parseOhMyPiTerminalRuntimeSessionId,
    projectOhMyPiTerminalRuntimeBreadcrumb,
    resolveOhMyPiTerminalRuntimeAgentDir,
    type OhMyPiTerminalRuntimeBreadcrumb,
    type ResolveOhMyPiTerminalRuntimeBreadcrumbParams,
} from '@happier-dev/plugins-ohmypi/agent/terminalRuntime/breadcrumb';

const resolveRuntimeBreadcrumb = createTerminalBreadcrumbResolver<
    ResolveOhMyPiTerminalRuntimeBreadcrumbParams,
    OhMyPiTerminalRuntimeBreadcrumb
>({
    agentDir: resolveOhMyPiTerminalRuntimeAgentDir,
    resolveTerminalId: (input) => input.terminalId ?? getTerminalId({ env: input.env ?? process.env }),
    breadcrumbSubdir: OH_MY_PI_TERMINAL_BREADCRUMB_SUBDIR,
    sessionsSubdir: OH_MY_PI_TERMINAL_SESSIONS_SUBDIR,
    parseSessionId: parseOhMyPiTerminalRuntimeSessionId,
    validateCwd: isOhMyPiTerminalRuntimeCwdMatch,
    validateSessionFile: () => true,
    projectSource: projectOhMyPiTerminalRuntimeBreadcrumb,
    canonicalizePath: canonicalizeOhMyPiTerminalRuntimePath,
});

export function runtimeBreadcrumb(
    params: ResolveOhMyPiTerminalRuntimeBreadcrumbParams,
): OhMyPiTerminalRuntimeBreadcrumb | undefined {
    return resolveRuntimeBreadcrumb(params);
}
