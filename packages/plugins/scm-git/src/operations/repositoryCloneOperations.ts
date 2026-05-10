import { readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmHostingRepositoryAuthSummary,
    type ScmHostingRepositorySummary,
    type ScmOperationErrorCode,
    type ScmRepositoryCloneInput,
    type ScmRepositoryCloneOutput,
    type ScmRepositoryCloneTarget,
    type ScmRepositoryCloneTargetDescription,
    type ScmWorkingSnapshot,
    type SourceControlCloneProtocol,
} from '@happier-dev/protocol';

import type { ScmBackendContext, ScmRepoDetection } from '../types.js';
import { runScmCommand, type ScmExecResult } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { detectGitRepo, getGitSnapshot } from '../repository.js';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';

const GIT_REPOSITORY_CLONE_TIMEOUT_MS = 120_000;

type ScmHostingProviderRuntimeServices = Readonly<Record<string, unknown>>;
type CloneProviderRef = ScmRepositoryCloneInput['provider'];
type CloneProviderUrlSafety = CloneProviderRef['urlSafety'];

type CloneTargetAdapter = Readonly<{
    describeCloneTargets: (input: Readonly<{
        provider: ScmRepositoryCloneInput['provider'];
        repository: ScmRepositoryCloneInput['repository'];
        runtimeServices?: ScmHostingProviderRuntimeServices;
    }>) => Promise<ScmRepositoryCloneTargetDescription>;
}>;

type CloneProviderDescriptor = Readonly<{
    id: string;
    kind: CloneProviderRef['kind'];
    displayName: string;
    baseUrl: string;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
    }> & Readonly<Record<string, unknown>>;
}>;

type HostingRepositoryRegistry = Pick<ResolvedScmHostingProviderRegistry, 'getAdapter'> & Readonly<{
    getProvider?: (id: string) => CloneProviderDescriptor | undefined;
    providers?: readonly CloneProviderDescriptor[];
}>;

type GitRepositoryCloneOperationDeps = Readonly<{
    registry?: HostingRepositoryRegistry;
    runtimeServices?: ScmHostingProviderRuntimeServices;
    runCommand?: typeof runScmCommand;
    detectRepo?: typeof detectGitRepo;
    readSnapshot?: (input: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
}>;

export type GitRepositoryCloneOperation = Readonly<{
    clone(input: Readonly<{
        context: ScmBackendContext;
        request: ScmRepositoryCloneInput;
    }>): Promise<ScmRepositoryCloneOutput>;
}>;

type DestinationPreflightResult =
    | Readonly<{ ok: true; parentPath: string; destinationPath: string }>
    | Readonly<{ ok: false; response: ScmRepositoryCloneOutput }>;

type CloneTargetSelectionResult =
    | Readonly<{
        ok: true;
        repository: ScmHostingRepositorySummary;
        target: ScmRepositoryCloneTarget & { protocol: 'ssh' | 'https' };
    }>
    | Readonly<{ ok: false; response: ScmRepositoryCloneOutput }>;

function errorResponse(
    error: string,
    errorCode: ScmOperationErrorCode,
    extra?: Omit<Partial<Extract<ScmRepositoryCloneOutput, { success: false }>>, 'success' | 'error' | 'errorCode'>,
): ScmRepositoryCloneOutput {
    return {
        success: false,
        error,
        errorCode,
        ...extra,
    };
}

function pathContainsTraversal(value: string): boolean {
    return value.split(/[\\/]+/).includes('..');
}

function hasUnsafePathInput(value: string): boolean {
    return value.includes('\0') || value.startsWith('~') || pathContainsTraversal(value);
}

async function preflightDestination(request: ScmRepositoryCloneInput): Promise<DestinationPreflightResult> {
    if (!request.confirmed || request.authorizationToken !== 'clone-repository') {
        return {
            ok: false,
            response: errorResponse(
                'Repository clone requires explicit user authorization.',
                SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                { remediation: { kind: 'confirmation_required' } },
            ),
        };
    }

    const parentPath = resolve(request.destinationParentPath);
    if (
        !isAbsolute(request.destinationParentPath)
        || hasUnsafePathInput(request.destinationParentPath)
        || hasUnsafePathInput(request.destinationDirectoryName)
        || /[\\/]/.test(request.destinationDirectoryName)
        || request.destinationDirectoryName === '.'
        || request.destinationDirectoryName === '..'
    ) {
        return {
            ok: false,
            response: errorResponse(
                'Repository clone destination must be an absolute parent path plus a safe child directory name.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    const destinationPath = resolve(parentPath, request.destinationDirectoryName);
    if (dirname(destinationPath) !== parentPath) {
        return {
            ok: false,
            response: errorResponse(
                'Repository clone destination must stay inside the selected parent directory.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    let parentStats;
    try {
        parentStats = await stat(parentPath);
    } catch {
        return {
            ok: false,
            response: errorResponse(
                'Repository clone destination parent does not exist.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }
    if (!parentStats.isDirectory()) {
        return {
            ok: false,
            response: errorResponse(
                'Repository clone destination parent is not a directory.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    try {
        const destinationStats = await stat(destinationPath);
        if (!destinationStats.isDirectory()) {
            return {
                ok: false,
                response: errorResponse(
                    'Repository clone destination already exists and is not a directory.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
        const entries = await readdir(destinationPath);
        if (entries.length > 0) {
            return {
                ok: false,
                response: errorResponse(
                    'Repository clone destination already contains files.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
    } catch (error) {
        const code = typeof error === 'object' && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        if (code !== 'ENOENT') {
            return {
                ok: false,
                response: errorResponse(
                    'Repository clone destination could not be inspected.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
    }

    return { ok: true, parentPath, destinationPath };
}

function isCloneTargetAdapter(adapter: unknown): adapter is CloneTargetAdapter {
    return Boolean(adapter)
        && typeof adapter === 'object'
        && typeof (adapter as Partial<CloneTargetAdapter>).describeCloneTargets === 'function';
}

function sanitizeRepositorySelector(
    repository: ScmRepositoryCloneInput['repository'],
): ScmRepositoryCloneInput['repository'] {
    return {
        nameWithOwner: repository.nameWithOwner,
        ...(repository.webUrl ? { webUrl: repository.webUrl } : {}),
        visibility: repository.visibility,
        ...(repository.defaultBranch !== undefined ? { defaultBranch: repository.defaultBranch } : {}),
    };
}

function cloneProviderUrlSafety(urlSafety: CloneProviderDescriptor['urlSafety']): CloneProviderUrlSafety {
    return {
        ...(urlSafety ?? {}),
        allowedSchemes: [...(urlSafety?.allowedSchemes ?? ['https:'])],
    };
}

function cloneProviderRef(provider: CloneProviderDescriptor): CloneProviderRef {
    return {
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        urlSafety: cloneProviderUrlSafety(provider.urlSafety),
    };
}

function resolveRegisteredProvider(input: Readonly<{
    registry: HostingRepositoryRegistry | null;
    requestedProvider: ScmRepositoryCloneInput['provider'];
}>): CloneProviderRef | null {
    const registered = input.registry?.getProvider?.(input.requestedProvider.id)
        ?? input.registry?.providers?.find((provider) => provider.id === input.requestedProvider.id)
        ?? null;
    if (!registered) return null;
    return cloneProviderRef(registered);
}

function isAuthReady(auth: ScmHostingRepositoryAuthSummary | undefined): boolean {
    if (!auth) return false;
    return auth.state === 'authenticated' || auth.profileKind === 'no_auth';
}

function selectCloneTarget(
    description: ScmRepositoryCloneTargetDescription,
    protocol: SourceControlCloneProtocol,
): CloneTargetSelectionResult {
    if (!isAuthReady(description.auth)) {
        return {
            ok: false,
            response: errorResponse(
                'Repository clone requires an authenticated or explicitly no-auth hosting provider state.',
                SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
                { remediation: description.auth?.remediation ?? { kind: 'auth_required' } },
            ),
        };
    }

    const targets = description.targets.filter((target): target is ScmRepositoryCloneTarget & { protocol: 'ssh' | 'https' } =>
        target.protocol === 'ssh' || target.protocol === 'https');
    const target = protocol === 'auto'
        ? targets.find((entry) => entry.isDefault) ?? targets[0]
        : targets.find((entry) => entry.protocol === protocol);

    if (!target) {
        return {
            ok: false,
            response: errorResponse(
                `The selected repository does not provide a ${protocol} clone target.`,
                SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            ),
        };
    }

    return {
        ok: true,
        repository: description.repository,
        target,
    };
}

async function readRegistry(deps?: GitRepositoryCloneOperationDeps): Promise<HostingRepositoryRegistry | null> {
    if (deps?.registry) return deps.registry;
    const { resolveDefaultPullRequestStatusProjectionRegistry } = await import('./pullRequestStatusProjection.js');
    return await resolveDefaultPullRequestStatusProjectionRegistry();
}

async function readRuntimeServices(
    deps: GitRepositoryCloneOperationDeps | undefined,
    defaultRuntimeServices: { current: ScmHostingProviderRuntimeServices | null },
): Promise<ScmHostingProviderRuntimeServices> {
    if (deps?.runtimeServices) return deps.runtimeServices;
    const { createScmHostingProviderRuntimeServices } = await import('../hostingProviders/runtimeServices.js');
    defaultRuntimeServices.current ??= createScmHostingProviderRuntimeServices();
    return defaultRuntimeServices.current;
}

async function describeCloneTargets(input: Readonly<{
    request: ScmRepositoryCloneInput;
    deps?: GitRepositoryCloneOperationDeps;
    runtimeServicesRef: { current: ScmHostingProviderRuntimeServices | null };
}>): Promise<CloneTargetSelectionResult> {
    const registry = await readRegistry(input.deps);
    const adapter = registry?.getAdapter(input.request.provider.id);
    const registeredProvider = resolveRegisteredProvider({
        registry,
        requestedProvider: input.request.provider,
    });
    if (!registeredProvider) {
        return {
            ok: false,
            response: errorResponse(
                `The selected hosting provider "${input.request.provider.displayName}" is not registered.`,
                SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                { remediation: { kind: 'unsupported_provider' } },
            ),
        };
    }
    if (!isCloneTargetAdapter(adapter)) {
        return {
            ok: false,
            response: errorResponse(
                `The selected hosting provider "${input.request.provider.displayName}" does not support repository clone target discovery.`,
                SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                { remediation: { kind: 'unsupported_provider' } },
            ),
        };
    }

    try {
        const description = await adapter.describeCloneTargets({
            provider: registeredProvider,
            repository: sanitizeRepositorySelector(input.request.repository),
            runtimeServices: await readRuntimeServices(input.deps, input.runtimeServicesRef),
        });
        return selectCloneTarget(description, input.request.protocol);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Hosting provider clone target discovery failed.';
        const code = typeof error === 'object' && error !== null
            ? (error as { errorCode?: unknown }).errorCode
            : undefined;
        return {
            ok: false,
            response: errorResponse(
                message,
                typeof code === 'string' && Object.values(SCM_OPERATION_ERROR_CODES).includes(code as ScmOperationErrorCode)
                    ? code as ScmOperationErrorCode
                    : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            ),
        };
    }
}

function contextWithDetection(
    context: ScmBackendContext,
    cwd: string,
    detection: ScmRepoDetection,
): ScmBackendContext {
    return {
        ...context,
        cwd,
        projectKey: `${context.projectKey}:clone:${cwd}`,
        detection,
    };
}

async function readClonedSnapshot(input: Readonly<{
    context: ScmBackendContext;
    destinationPath: string;
    detectRepo: typeof detectGitRepo;
    readSnapshot: (snapshotInput: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
}>): Promise<ScmWorkingSnapshot | ScmRepositoryCloneOutput> {
    const detection = await input.detectRepo({ cwd: input.destinationPath });
    if (!detection.isRepo) {
        return errorResponse(
            'Repository clone completed but the cloned directory could not be detected as a Git repository.',
            SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        );
    }

    const snapshot = await input.readSnapshot({
        context: contextWithDetection(input.context, input.destinationPath, detection),
    });
    return snapshot ?? errorResponse(
        'Repository clone completed but the cloned repository snapshot could not be read.',
        SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    );
}

function isFailureResponse(value: ScmWorkingSnapshot | ScmRepositoryCloneOutput): value is ScmRepositoryCloneOutput {
    return 'success' in value;
}

function mapCloneCommandFailure(result: ScmExecResult): ScmRepositoryCloneOutput {
    return errorResponse(
        result.stderr || 'Failed to clone repository.',
        mapGitErrorCode(result.stderr),
        {
            stdout: result.stdout,
            stderr: result.stderr,
        },
    );
}

export function createGitRepositoryCloneOperation(
    deps?: GitRepositoryCloneOperationDeps,
): GitRepositoryCloneOperation {
    const runtimeServicesRef: { current: ScmHostingProviderRuntimeServices | null } = { current: null };
    const runCommand = deps?.runCommand ?? runScmCommand;
    const detectRepo = deps?.detectRepo ?? detectGitRepo;
    const readSnapshot = deps?.readSnapshot ?? (async ({ context }) => {
        const response = await getGitSnapshot({ context });
        return response.success ? response.snapshot ?? null : null;
    });

    return Object.freeze({
        async clone({ context, request }) {
            const destination = await preflightDestination(request);
            if (!destination.ok) return destination.response;

            const cloneTarget = await describeCloneTargets({
                request,
                deps,
                runtimeServicesRef,
            });
            if (!cloneTarget.ok) return cloneTarget.response;

            const clone = await runCommand({
                bin: 'git',
                cwd: destination.parentPath,
                args: ['clone', cloneTarget.target.url, destination.destinationPath],
                timeoutMs: GIT_REPOSITORY_CLONE_TIMEOUT_MS,
                env: buildScmNonInteractiveEnv(),
            });
            if (!clone.success) {
                return mapCloneCommandFailure(clone);
            }

            const snapshot = await readClonedSnapshot({
                context,
                destinationPath: destination.destinationPath,
                detectRepo,
                readSnapshot,
            });
            if (isFailureResponse(snapshot)) return snapshot;

            return {
                success: true,
                destinationPath: destination.destinationPath,
                cloneProtocol: cloneTarget.target.protocol,
                cloneUrl: cloneTarget.target.url,
                repository: cloneTarget.repository,
                snapshot,
                stdout: clone.stdout,
                stderr: clone.stderr,
            };
        },
    });
}

export const gitRepositoryClone = createGitRepositoryCloneOperation().clone;
