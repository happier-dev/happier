import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { ensureJavaScriptRuntimeExecutable } from '@/runtime/js/ensureJavaScriptRuntimeExecutable';

import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';

export async function resolveDaemonServiceInstallRuntimeTarget(options: Readonly<{
    currentExecPath?: string | null;
    explicitNodePath?: string | null;
    explicitEntryPath?: string | null;
}> = {}): Promise<Readonly<{
    nodePath: string;
    entryPath: string;
}>> {
    const currentExecPath = options.currentExecPath ?? process.execPath;
    const explicitNodePath = String(options.explicitNodePath ?? '').trim();
    const explicitEntryPath = String(options.explicitEntryPath ?? '').trim();
    const runtimeExecutable = explicitNodePath
        ? null
        : await ensureJavaScriptRuntimeExecutable({
            isBunRuntime: false,
            currentExecPath,
        });

    if (!explicitNodePath && !runtimeExecutable && !explicitEntryPath) {
        throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('Daemon service installation'));
    }

    return resolveDaemonServiceRuntimeTarget({
        currentExecPath,
        runtimeExecutable,
        explicitNodePath,
        explicitEntryPath,
    });
}
