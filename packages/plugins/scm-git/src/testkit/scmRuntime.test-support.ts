import { spawnSync } from 'node:child_process';

import {
    runWithScmHostingProviderRuntimeServices,
    type ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';
import {
    runWithScmBackendRuntimeServices,
    type ScmBackendCommandRunInput,
    type ScmBackendCommandRunResult,
    type ScmBackendRuntimeServices,
} from '@happier-dev/plugin-sdk/experimental/scm/backend';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';

export type GitScmCommandRunner = (input: ScmBackendCommandRunInput) => Promise<ScmBackendCommandRunResult>;

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
        getAdapter: () => undefined,
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
