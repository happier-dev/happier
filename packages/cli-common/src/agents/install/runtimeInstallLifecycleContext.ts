import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createManagedToolScratchDir } from '../createManagedToolScratchDir.js';
import { removeHappierTempDirAsync } from '../../tempDirs/createHappierTempDir.js';
import type { AgentCliInstallPlan } from '../install.js';
import { resolveHappyHomeDirFromEnvironment } from '../resolveHappyHomeDir.js';
import { resolveAgentCliManagedInstallRootForRuntime, type AgentCliRuntimeDescriptor } from '../resolution.js';
import type { AgentInstallProgressCallback } from '../installProgress.js';

type AppendCommandLogFn = (
    logPath: string,
    cmd: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
    status: number | null,
    signal: NodeJS.Signals | null,
) => void;

type AppendLogLineFn = (logPath: string, line: string) => void;

export type RuntimeInstallLifecycleContext = Readonly<{
    logPath: string;
    vendorScratchDir: string | null;
    appendCommandLog: AppendCommandLogFn;
    appendLogLine: AppendLogLineFn;
    onProgress: AgentInstallProgressCallback;
}>;

function resolveLogPath(params: Readonly<{ agentId: string; logDir?: string | null; env: NodeJS.ProcessEnv }>): string {
    const base =
        typeof params.logDir === 'string' && params.logDir.trim()
            ? params.logDir.trim()
            : join(resolveHappyHomeDirFromEnvironment(params.env), 'logs', 'agent-installs');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    try {
        chmodSync(base, 0o700);
    } catch {
        // best-effort
    }
    return join(base, `install-agent-${params.agentId}-${Date.now()}.log`);
}

function writeLogHeader(logPath: string, plan: AgentCliInstallPlan): void {
    writeFileSync(
        logPath,
        [
            `# agentId: ${plan.agentId}`,
            `# platform: ${plan.platform}`,
            `# installMode: ${plan.installMode}`,
            `# requiresAdmin: ${plan.requiresAdmin ? '1' : '0'}`,
            '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 },
    );
    try {
        chmodSync(logPath, 0o600);
    } catch {
        // best-effort
    }
}

function appendCommandLog(
    logPath: string,
    cmd: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
    status: number | null,
    signal: NodeJS.Signals | null,
): void {
    appendFileSync(
        logPath,
        [
            '',
            `## ${cmd} ${args.join(' ')}`.trim(),
            `# exit: ${status ?? 'null'}`,
            `# signal: ${signal ?? 'null'}`,
            '',
            '### stdout',
            stdout || '',
            '',
            '### stderr',
            stderr || '',
            '',
        ].join('\n'),
        'utf8',
    );
}

function appendLogLine(logPath: string, line: string): void {
    appendFileSync(logPath, `${line}\n`, 'utf8');
}

export async function createRuntimeInstallLifecycleContext(params: Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    plan: AgentCliInstallPlan;
    env: NodeJS.ProcessEnv;
    logDir?: string | null;
    onProgress?: AgentInstallProgressCallback;
}>): Promise<RuntimeInstallLifecycleContext> {
    const logPath = resolveLogPath({ agentId: params.runtimeSpec.id, logDir: params.logDir, env: params.env });
    writeLogHeader(logPath, params.plan);
    const vendorScratchDir =
        params.plan.installMode === 'vendor_recipe'
            ? await createManagedToolScratchDir({
            installDir: resolveAgentCliManagedInstallRootForRuntime(params.runtimeSpec, { processEnv: params.env }),
                  prefix: 'vendor-install',
              })
            : null;
    let progressStarted = false;
    let completionReported = false;
    const onProgress: AgentInstallProgressCallback = (event) => {
        if (event.t === 'log') {
            appendLogLine(logPath, event.line);
            progressStarted = false;
            completionReported = false;
        } else {
            const complete = event.bytesTotal !== null && event.bytesDone === event.bytesTotal;
            // Persist the first sample and natural completion, not every streamed chunk.
            if (!progressStarted || (complete && !completionReported)) {
                appendLogLine(logPath, `# download: ${event.bytesDone}/${event.bytesTotal ?? 'unknown'} bytes`);
            }
            progressStarted = true;
            completionReported ||= complete;
        }
        params.onProgress?.(event);
    };
    return {
        logPath,
        vendorScratchDir,
        onProgress,
        appendCommandLog,
        appendLogLine: (path, line) => {
            appendLogLine(path, line);
            params.onProgress?.({ t: 'log', line });
        },
    };
}

export async function disposeRuntimeInstallLifecycleContext(context: RuntimeInstallLifecycleContext): Promise<void> {
    if (context.vendorScratchDir) {
        await removeHappierTempDirAsync(context.vendorScratchDir);
    }
}
