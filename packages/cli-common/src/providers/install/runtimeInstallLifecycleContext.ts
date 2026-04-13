import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createManagedToolScratchDir } from '../createManagedToolScratchDir.js';
import type { ProviderCliInstallPlan } from '../install.js';
import { resolveHappyHomeDirFromEnvironment } from '../resolveHappyHomeDir.js';
import type { ProviderCliRuntimeDescriptor } from '../resolution.js';

type AppendCommandLogFn = (
    logPath: string,
    cmd: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
    status: number | null,
) => void;

type AppendLogLineFn = (logPath: string, line: string) => void;

export type RuntimeInstallLifecycleContext = Readonly<{
    logPath: string;
    vendorScratchDir: string | null;
    appendCommandLog: AppendCommandLogFn;
    appendLogLine: AppendLogLineFn;
}>;

function resolveLogPath(params: Readonly<{ providerId: string; logDir?: string | null; env: NodeJS.ProcessEnv }>): string {
    const base =
        typeof params.logDir === 'string' && params.logDir.trim()
            ? params.logDir.trim()
            : join(resolveHappyHomeDirFromEnvironment(params.env), 'logs', 'provider-installs');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    try {
        chmodSync(base, 0o700);
    } catch {
        // best-effort
    }
    return join(base, `install-provider-${params.providerId}-${Date.now()}.log`);
}

function writeLogHeader(logPath: string, plan: ProviderCliInstallPlan): void {
    writeFileSync(
        logPath,
        [
            `# providerId: ${plan.providerId}`,
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

function appendCommandLog(logPath: string, cmd: string, args: readonly string[], stdout: string, stderr: string, status: number | null): void {
    appendFileSync(
        logPath,
        [
            '',
            `## ${cmd} ${args.join(' ')}`.trim(),
            `# exit: ${status ?? 'null'}`,
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

function resolveProviderToolInstallDir(providerId: string, env: NodeJS.ProcessEnv): string {
    return join(resolveHappyHomeDirFromEnvironment(env), 'tools', 'providers', providerId);
}

export async function createRuntimeInstallLifecycleContext(params: Readonly<{
    runtimeSpec: ProviderCliRuntimeDescriptor;
    plan: ProviderCliInstallPlan;
    env: NodeJS.ProcessEnv;
    logDir?: string | null;
}>): Promise<RuntimeInstallLifecycleContext> {
    const logPath = resolveLogPath({ providerId: params.runtimeSpec.id, logDir: params.logDir, env: params.env });
    writeLogHeader(logPath, params.plan);
    const vendorScratchDir =
        params.plan.installMode === 'vendor_recipe'
            ? await createManagedToolScratchDir({
                  installDir: resolveProviderToolInstallDir(params.runtimeSpec.id, params.env),
                  prefix: 'vendor-install',
              })
            : null;
    return {
        logPath,
        vendorScratchDir,
        appendCommandLog,
        appendLogLine,
    };
}

export async function disposeRuntimeInstallLifecycleContext(context: RuntimeInstallLifecycleContext): Promise<void> {
    if (context.vendorScratchDir) {
        await rm(context.vendorScratchDir, { recursive: true, force: true });
    }
}
