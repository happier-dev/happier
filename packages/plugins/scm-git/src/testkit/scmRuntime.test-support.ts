import { spawn, spawnSync } from 'node:child_process';

import {
    runWithHostingProviderRuntimeServices as runWithScmHostingProviderRuntimeServices,
    type HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';
import {
    runWithBackendRuntimeServices as runWithScmBackendRuntimeServices,
    type BackendCommandRunInput as ScmBackendCommandRunInput,
    type BackendCommandRunResult as ScmBackendCommandRunResult,
    type BackendRuntimeServices as ScmBackendRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/backend';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';

export type GitScmCommandRunner = (input: ScmBackendCommandRunInput) => Promise<ScmBackendCommandRunResult>;

// Real OS/Git boundary for tests that must pause a prepared ref transaction.
function runInteractiveGitCommand(input: ScmBackendCommandRunInput): Promise<ScmBackendCommandRunResult> {
    const interaction = input.stdinInteraction;
    if (!interaction) throw new Error('Expected stdin interaction');
    if (input.signal?.aborted) return Promise.resolve({ success: false, stdout: '', stderr: 'SCM command was aborted', exitCode: -1 });
    return new Promise((resolve) => {
        const child = spawn('git', [...input.args], {
            cwd: input.cwd, env: input.env ? { ...process.env, ...input.env } : process.env,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let lineBuffer = '';
        let started = false;
        let responded = false;
        let closed = false;
        let timedOut = false;
        let aborted = false;
        let outputLimitExceeded = false;
        let error = '';
        let outputBytes = 0;
        const abort = () => { aborted = true; child.stdin.end(); child.kill(); };
        const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill(); }, input.timeoutMs);
        child.stdin.on('error', (reason: Error) => { error = reason.message; });
        child.on('error', (reason) => { error = reason.message; });
        const collect = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
            outputBytes += chunk.length;
            if (input.maxOutputBytes !== undefined && outputBytes > input.maxOutputBytes) {
                outputLimitExceeded = true;
                child.kill();
                return;
            }
            if (channel === 'stderr') { stderr += chunk.toString(); return; }
            stdout += chunk.toString();
            if (started || closed || aborted || timedOut) return;
            lineBuffer += chunk.toString();
            let newline: number;
            while ((newline = lineBuffer.indexOf('\n')) >= 0) {
                const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
                lineBuffer = lineBuffer.slice(newline + 1);
                if (line !== interaction.readyLine) continue;
                started = true;
                void Promise.resolve().then(() => {
                    if (closed || aborted || timedOut || outputLimitExceeded) return;
                    return interaction.respond();
                }).then((response) => {
                    if (response === undefined || closed || aborted || timedOut || outputLimitExceeded) return;
                    responded = true;
                    child.stdin.end(response);
                }, (reason: unknown) => {
                    if (closed) return;
                    error = reason instanceof Error ? reason.message : String(reason);
                    child.stdin.end();
                });
                break;
            }
        };
        child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
        child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
        child.on('close', (code) => {
            closed = true;
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', abort);
            resolve({
                success: code === 0 && responded && !error && !timedOut && !aborted && !outputLimitExceeded,
                stdout, stderr: [stderr, error].filter(Boolean).join('\n'), exitCode: aborted ? -1 : code ?? -1,
                timedOut, outputLimitExceeded,
            });
        });
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        else if (input.stdin !== undefined) child.stdin.write(input.stdin);
    });
}

export function createRealGitScmBackendRuntimeServices(): ScmBackendRuntimeServices {
    return {
        async runCommand(input) {
            if (input.command !== 'git') {
                return {
                    success: false,
                    stdout: '',
                    stderr: `Unsupported command: ${input.command}`,
                    exitCode: -1,
                };
            }

            if (input.stdinInteraction) return await runInteractiveGitCommand(input);

            const result = spawnSync('git', [...input.args], {
                cwd: input.cwd,
                input: input.stdin,
                encoding: 'utf8',
                env: input.env ? { ...process.env, ...input.env } : process.env,
                maxBuffer: input.maxOutputBytes,
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: input.timeoutMs,
            });

            const stderr = result.error
                ? String(result.error.message || result.error)
                : result.stderr ?? '';

            return {
                success: result.status === 0,
                stdout: result.stdout ?? '',
                stderr,
                exitCode: result.status ?? -1,
                timedOut: result.error != null && 'code' in result.error && result.error.code === 'ETIMEDOUT',
            };
        },
    };
}

export function createEmptyScmHostingProviderRegistry(): ResolvedScmHostingProviderRegistry {
    return {
        providers: [],
        providersById: new Map(),
        diagnostics: [],
        getProvider: () => undefined,
        getRouting: () => undefined,
        getPullRequests: () => undefined,
        getPullRequestCheckout: () => undefined,
        getRepositoryPublishing: () => undefined,
        getRepositoryClone: () => undefined,
        detectRemote: (input) => ({
            kind: 'unknown',
            provider: {
                id: 'unknown',
                kind: 'unknown',
                displayName: 'Unknown SCM hosting provider',
                ...(input.remoteName ? { remoteName: input.remoteName } : {}),
                unsupportedReason: 'no_registered_provider_detected',
            },
        }),
        buildCompareUrl: (input) => ({
            kind: 'unsupported',
            reason: 'unknown_provider',
            provider: input.provider,
        }),
    };
}

export function createScmHostingProviderRuntimeServicesForTest(
    registry: ResolvedScmHostingProviderRegistry = createEmptyScmHostingProviderRegistry(),
): ScmHostingProviderRuntimeServices {
    return {
        resolveScmHostingProviderRegistry: async () => registry,
    };
}

export function runWithRealGitScmRuntime<T>(
    callback: () => T,
    options?: Readonly<{
        hostingProviderRuntimeServices?: ScmHostingProviderRuntimeServices;
    }>,
): T {
    return runWithScmBackendRuntimeServices(
        createRealGitScmBackendRuntimeServices(),
        () => runWithScmHostingProviderRuntimeServices(
            options?.hostingProviderRuntimeServices ?? createScmHostingProviderRuntimeServicesForTest(),
            callback,
        ),
    );
}

export function runWithGitScmCommandRunner<T>(runner: GitScmCommandRunner, callback: () => T): T {
    return runWithScmBackendRuntimeServices({
        async runCommand(input) {
            if (input.command !== 'git') {
                return {
                    success: false,
                    stdout: '',
                    stderr: `Unsupported command: ${input.command}`,
                    exitCode: -1,
                };
            }
            return await runner(input);
        },
    }, callback);
}
