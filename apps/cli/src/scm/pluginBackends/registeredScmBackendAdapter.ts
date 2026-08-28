import {
    createScmCapabilitiesFromBackendCapabilities,
    SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/protocol';
import type {
    ScmBackendCapabilities,
    ScmCapabilities,
    ScmPullRequestRunStackedResponse,
    ScmRepoMode,
} from '@happier-dev/protocol';
import type {
    BackendRuntimeRegistration as ScmBackendRuntimeRegistration,
    BackendRuntimeServices as ScmBackendRuntimeServices,
    PortableWorkspacePathClassification as PluginPortableWorkspacePathClassification,
} from '@happier-dev/plugin-sdk/scm/backend';
import type {
    HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { runWithHostingProviderRuntimeServices as runWithHostSuppliedScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { runWithBackendRuntimeServices as runWithScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

import type { ScmBackend } from '../types';
import { resolveScmBackendCapabilities } from '../capabilities/resolveScmBackendCapabilities';
import type { ScmWorkspaceIntegrationPortableWorkspacePathClassification as HostPortableWorkspacePathClassification } from '../workspace/portableWorkspacePath';
import { runScmCommand as runHostScmCommand } from '../runtime';
import {
    createScmInstallableCommandAuthorization,
    rejectUnauthorizedScmInstallableCommand,
} from '../commandAuthorization';

type UnsupportedResult = Readonly<{
    success: false;
    errorCode: typeof SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED;
    error: string;
}>;

const DEFAULT_SCM_OPERATION_SIGNAL = new AbortController().signal;

function withOperationSignal<TInput extends object>(input: TInput): TInput & Readonly<{ signal: AbortSignal }> {
    const context = Reflect.get(input, 'context') as Readonly<{ signal?: AbortSignal }> | undefined;
    return Object.freeze({
        ...input,
        signal: context?.signal ?? DEFAULT_SCM_OPERATION_SIGNAL,
    });
}

function unsupportedOperation(): Promise<UnsupportedResult> {
    return Promise.resolve({
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'SCM backend operation is not implemented by this plugin backend',
    });
}

function unsupportedWorktreeCreate(): Promise<Awaited<ReturnType<ScmBackend['worktreeCreate']>>> {
    return Promise.resolve({
        success: false,
        worktreePath: '',
        branchName: '',
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'SCM backend operation is not implemented by this plugin backend',
    });
}

function unsupportedRunStackedPullRequest(): Promise<ScmPullRequestRunStackedResponse> {
    return Promise.resolve({
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'SCM backend operation is not implemented by this plugin backend',
        events: [],
    });
}

/**
 * `HostingProviderRuntimeServices` has only optional members, so `{}` is a valid value of the type:
 * a fabricated empty one is indistinguishable from a host that genuinely offers nothing, and every
 * hosting plugin reads an absent `executeCommand` as "the CLI is not installed". When the host
 * supplied no hosting services we therefore never enter the scope, so a plugin's
 * `readCurrentHostingProviderRuntimeServices()` reports `null` — no capability — instead of an
 * empty capability that answers "nothing here".
 */
function runWithScmHostingProviderRuntimeServices<T>(
    hostingServices: ScmHostingProviderRuntimeServices | null,
    callback: () => T,
    options?: Readonly<{ signal?: AbortSignal }>,
): T {
    if (!hostingServices) return callback();
    return runWithHostSuppliedScmHostingProviderRuntimeServices(hostingServices, callback, options);
}

function useHandler<TInput extends object, TResult>(
    services: ScmBackendRuntimeServices,
    hostingServices: ScmHostingProviderRuntimeServices | null,
    handler: ((input: TInput & Readonly<{ signal: AbortSignal }>) => Promise<TResult> | TResult) | undefined,
    input: TInput,
): Promise<TResult | UnsupportedResult> {
    if (!handler) {
        return unsupportedOperation();
    }
    const operationInput = withOperationSignal(input);
    return runWithScmBackendRuntimeServices(
        services,
        () => runWithScmHostingProviderRuntimeServices(
            hostingServices,
            () => Promise.resolve(handler(operationInput)),
            { signal: operationInput.signal },
        ),
    );
}

function createScmBackendRuntimeServices(
    definition: ScmBackendExecutableDefinition,
): ScmBackendRuntimeServices {
    const commandAuthorization = createScmInstallableCommandAuthorization(definition.commands);
    return {
        async runCommand(input) {
            const unauthorizedCommand = rejectUnauthorizedScmInstallableCommand({
                ...input,
                authorization: commandAuthorization,
            });
            if (unauthorizedCommand) return unauthorizedCommand;
            return await runHostScmCommand({
                bin: input.command,
                installableKey: input.installableKey,
                cwd: input.cwd,
                args: [...input.args],
                timeoutMs: input.timeoutMs,
                stdin: input.stdin,
                maxOutputBytes: input.maxOutputBytes,
                env: input.env,
            });
        },
    };
}

export type ScmBackendExecutableDefinition = Readonly<{
    repoModes: readonly ScmRepoMode[];
    capabilities: ScmBackendCapabilities;
    commands: readonly Readonly<{ installableKey: string; command: string }>[];
}>;

function normalizePortableWorkspacePathClassification(
    classification: PluginPortableWorkspacePathClassification,
): HostPortableWorkspacePathClassification {
    if (classification === 'scm_administrative') {
        return 'non_portable';
    }

    return classification;
}

function createWorkspaceIntegrationAdapter(
    services: ScmBackendRuntimeServices,
    hostingServices: ScmHostingProviderRuntimeServices | null,
    handlers: ScmBackendRuntimeRegistration['handlers']['workspaceIntegration'],
): ScmBackend['workspaceIntegration'] | undefined {
    if (!handlers) return undefined;

    return {
        ...(handlers.inspectWorkspaceLocation ? { inspectWorkspaceLocation: async (input) => await runWithScmBackendRuntimeServices(
            services,
            async () => await runWithScmHostingProviderRuntimeServices(
                hostingServices,
                async () => await handlers.inspectWorkspaceLocation!(input),
            ),
        ) } : {}),
        ...(handlers.reconcilePostMaterialization ? {
            reconcilePostMaterialization: async (input) => {
                await runWithScmBackendRuntimeServices(
                    services,
                    async () => await runWithScmHostingProviderRuntimeServices(
                        hostingServices,
                        async () => await handlers.reconcilePostMaterialization?.(input),
                    ),
                );
            },
        } : {}),
        ...(handlers.prepareReviewWorkspace ? {
            prepareReviewWorkspace: async (input) => {
                const operationInput = withOperationSignal(input);
                return await runWithScmBackendRuntimeServices(
                    services,
                    async () => await runWithScmHostingProviderRuntimeServices(
                        hostingServices,
                        async () => await handlers.prepareReviewWorkspace!(operationInput),
                        { signal: operationInput.signal },
                    ),
                );
            },
        } : {}),
        ...(handlers.verifyPreparedReviewWorkspace ? {
            verifyPreparedReviewWorkspace: async (input) => {
                const operationInput = withOperationSignal(input);
                return await runWithScmBackendRuntimeServices(
                    services,
                    async () => await runWithScmHostingProviderRuntimeServices(
                        hostingServices,
                        async () => await handlers.verifyPreparedReviewWorkspace!(operationInput),
                        { signal: operationInput.signal },
                    ),
                );
            },
        } : {}),
        ...(handlers.realizeWorkspaceCheckout ? {
            realizeWorkspaceCheckout: async (input) => await runWithScmBackendRuntimeServices(
                services,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingServices,
                    async () => await handlers.realizeWorkspaceCheckout!(input),
                ),
            ),
        } : {}),
        ...(handlers.createWorkspaceCheckout ? {
            createWorkspaceCheckout: async (input) => await runWithScmBackendRuntimeServices(
                services,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingServices,
                    async () => await handlers.createWorkspaceCheckout!(input),
                ),
            ),
        } : {}),
        ...(handlers.materializeWorkspaceCheckout ? {
            materializeWorkspaceCheckout: async (input) => await runWithScmBackendRuntimeServices(
                services,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingServices,
                    async () => await handlers.materializeWorkspaceCheckout!(input),
                ),
            ),
        } : {}),
        ...(handlers.resolveWorkspaceTransferEntries ? {
            resolveWorkspaceTransferEntries: async (input) => await runWithScmBackendRuntimeServices(
                services,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingServices,
                    async () => await handlers.resolveWorkspaceTransferEntries!(input),
                ),
            ),
        } : {}),
        ...(handlers.resolveWorkspaceTransferMetadata ? {
            resolveWorkspaceTransferMetadata: async (input) => await runWithScmBackendRuntimeServices(
                services,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingServices,
                    async () => await handlers.resolveWorkspaceTransferMetadata!(input),
                ),
            ),
        } : {}),
        ...(handlers.assertPortableWorkspaceEntries ? {
            assertPortableWorkspaceEntries: async (input) => {
                await runWithScmBackendRuntimeServices(
                    services,
                    async () => await runWithScmHostingProviderRuntimeServices(
                        hostingServices,
                        async () => await handlers.assertPortableWorkspaceEntries?.(input),
                    ),
                );
            },
        } : {}),
        ...(handlers.classifyPortableWorkspaceTransferEntry ? {
            classifyPortableWorkspaceTransferEntry: (input) => normalizePortableWorkspacePathClassification(
                handlers.classifyPortableWorkspaceTransferEntry!(input),
            ),
        } : {}),
        ...(handlers.isAdministrativeWorkspacePath ? {
            isAdministrativeWorkspacePath: (input) => handlers.isAdministrativeWorkspacePath!(input),
        } : {}),
        ...(handlers.classifyPortableWorkspacePath ? {
            classifyPortableWorkspacePath: (input) => normalizePortableWorkspacePathClassification(
                handlers.classifyPortableWorkspacePath!(input),
            ),
        } : {}),
    };
}

export function createRegisteredScmBackendAdapter(input: Readonly<{
    definition: Readonly<{ id: string; kind?: string }>;
    qualifiedId: string;
    executableDefinition: ScmBackendExecutableDefinition;
    registration: ScmBackendRuntimeRegistration;
    hostingProviderRuntimeServices?: ScmHostingProviderRuntimeServices;
}>): ScmBackend {
    const preferredMode = input.executableDefinition.repoModes[0] ?? '.git';
    const runtimeServices = createScmBackendRuntimeServices(input.executableDefinition);
    const hostingProviderRuntimeServices = input.hostingProviderRuntimeServices ?? null;

    function getCapabilities(inputOptions: Readonly<{
        mode: Parameters<ScmBackend['getCapabilities']>[0]['mode'];
        executableAvailable?: boolean;
    }>): ScmCapabilities {
        return createScmCapabilitiesFromBackendCapabilities(resolveScmBackendCapabilities({
            declaredCapabilities: input.executableDefinition.capabilities,
            mode: inputOptions.mode,
            supportedRepoModes: input.executableDefinition.repoModes,
            executableAvailable: inputOptions.executableAvailable,
        }));
    }

    return {
        id: input.qualifiedId,
        localId: input.definition.id,
        ...(input.definition.kind ? { kind: input.definition.kind } : {}),
        declaredCapabilities: input.executableDefinition.capabilities,
        selection: {
            modeSelectionScores: Object.freeze(Object.fromEntries(
                input.executableDefinition.repoModes.map((mode) => [mode, mode === '.sl' ? 100 : 50]),
            )),
            preferenceAllowedModes: Object.freeze([...input.executableDefinition.repoModes]),
        },
        async detectRepo({ cwd }) {
            const handler = input.registration.handlers.detection?.detectRepo;
            return handler
                ? await runWithScmBackendRuntimeServices(
                    runtimeServices,
                    async () => await runWithScmHostingProviderRuntimeServices(
                        hostingProviderRuntimeServices,
                        async () => await handler({ cwd }),
                    ),
                )
                : {
                isRepo: false,
                rootPath: null,
                mode: null,
            };
        },
        getCapabilities,
        async describeBackend({ context, request }) {
            const fallbackCapabilities = getCapabilities({
                mode: context.detection.mode ?? preferredMode,
            });
            const handler = input.registration.handlers.detection?.describeBackend;
            const response = handler ? await runWithScmBackendRuntimeServices(
                runtimeServices,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingProviderRuntimeServices,
                    async () => await handler(withOperationSignal({ context, request })),
                ),
            ) : {
                success: true,
                backendId: input.qualifiedId,
                repoMode: context.detection.mode ?? preferredMode,
                capabilities: fallbackCapabilities,
            };
            return response.success
                ? Object.freeze({ ...response, backendId: input.qualifiedId })
                : response;
        },
        async statusSnapshot({ context, request }) {
            const handler = input.registration.handlers.read?.statusSnapshot;
            if (!handler) {
                return unsupportedOperation();
            }
            const response = await runWithScmBackendRuntimeServices(
                runtimeServices,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingProviderRuntimeServices,
                    async () => await handler(withOperationSignal({ context, request })),
                ),
            );
            if (!response.snapshot) return response;
            return Object.freeze({
                ...response,
                snapshot: Object.freeze({
                    ...response.snapshot,
                    repo: Object.freeze({
                        ...response.snapshot.repo,
                        backendId: input.qualifiedId,
                    }),
                }),
            });
        },
        async worktreesEnrichment({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.read?.worktreesEnrichment, { context, request });
        },
        async diffFile({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.read?.diffFile, { context, request });
        },
        async diffCommit({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.read?.diffCommit, { context, request });
        },
        async changeInclude({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.changeSet?.include, { context, request });
        },
        async changeExclude({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.changeSet?.exclude, { context, request });
        },
        async changeDiscard({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.changeSet?.discard, { context, request });
        },
        async commitCreate({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.commit?.create, { context, request });
        },
        async commitBackout({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.commit?.backout, { context, request });
        },
        async logList({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.read?.logList, { context, request });
        },
        async branchList({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.branch?.list, { context, request });
        },
        async branchCreate({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.branch?.create, { context, request });
        },
        async branchCheckout({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.branch?.checkout, { context, request });
        },
        async branchMerge({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.branch?.merge, { context, request });
        },
        async branchRebase({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.branch?.rebase, { context, request });
        },
        async branchOperationContinue({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.branch?.operationContinue, { context, request });
        },
        async branchOperationAbort({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.branch?.operationAbort, { context, request });
        },
        async worktreeCreate({ context, request }) {
            const handler = input.registration.handlers.worktree?.create;
            if (!handler) return unsupportedWorktreeCreate();
            return await runWithScmBackendRuntimeServices(
                runtimeServices,
                async () => await runWithScmHostingProviderRuntimeServices(
                    hostingProviderRuntimeServices,
                    async () => await handler(withOperationSignal({ context, request })),
                ),
            );
        },
        async worktreeRemove({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.worktree?.remove, { context, request });
        },
        async worktreePrune({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.worktree?.prune, { context, request });
        },
        async remoteAdd({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.remote?.add, { context, request });
        },
        async remoteSetUrl({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.remote?.setUrl, { context, request });
        },
        async remoteRemove({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.remote?.remove, { context, request });
        },
        async remoteFetch({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.remote?.fetch, { context, request });
        },
        async remotePull({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.remote?.pull, { context, request });
        },
        async remotePush({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.remote?.push, { context, request });
        },
        async remotePublish({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.remote?.publish, { context, request });
        },
        async repositoryInit({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.lifecycle?.init, { context, request });
        },
        async repositoryClone({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.lifecycle?.clone, { context, request });
        },
        async removeIndexLock({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.lifecycle?.removeIndexLock, { context, request });
        },
        async stashList({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.read?.stashList, { context, request });
        },
        async stashDrop({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.stash?.drop, { context, request });
        },
        async stashPop({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.stash?.pop, { context, request });
        },
        async stashApply({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.stash?.apply, { context, request });
        },
        async stashShow({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.stash?.show, { context, request });
        },
        async hostingRepositoryDescribePublishTargets({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.repositoryDescribePublishTargets, { context, request });
        },
        async hostingRepositoryPublish({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.repositoryPublish, { context, request });
        },
        async pullRequestList({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.pullRequestList, { context, request });
        },
        async pullRequestGet({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.pullRequestGet, { context, request });
        },
        async pullRequestOpenCompose({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.pullRequestOpenCompose, { context, request });
        },
        async pullRequestOpenOrReuse({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.pullRequestOpenOrReuse, { context, request });
        },
        async pullRequestCheckout({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.pullRequestCheckout, { context, request });
        },
        async pullRequestPrepareWorktree({ context, request }) {
            return useHandler(runtimeServices, hostingProviderRuntimeServices, input.registration.handlers.hosting?.pullRequestPrepareWorktree, { context, request });
        },
        async pullRequestRunStacked({ context, request }) {
            const handler = input.registration.handlers.hosting?.pullRequestRunStacked;
            if (!handler) return unsupportedRunStackedPullRequest();
            return runWithScmBackendRuntimeServices(
                runtimeServices,
                () => runWithScmHostingProviderRuntimeServices(
                    hostingProviderRuntimeServices,
                    () => Promise.resolve(handler(withOperationSignal({ context, request }))),
                ),
            );
        },
        workspaceIntegration: createWorkspaceIntegrationAdapter(
            runtimeServices,
            hostingProviderRuntimeServices,
            input.registration.handlers.workspaceIntegration,
        ),
    };
}
