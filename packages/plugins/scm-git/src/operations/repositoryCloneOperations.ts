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
} from '@happier-dev/plugin-sdk/scm';
import {
    readCurrentScmHostingProviderRuntimeServices,
    type ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';

import type { ScmBackendContext } from '../types.js';
import { runScmCommand, type ScmExecResult } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { detectGitRepo, getGitSnapshot } from '../repository.js';
import type { ResolvedScmHostingProviderRegistry } from '../hostingProviders/types.js';
import {
    cleanupPrivateCloneDestination,
    preflightDestination,
    publishPrivateCloneDestination,
    reserveCloneDestination,
} from './repositoryCloneDestination.js';
import { readClonedSnapshot } from './repositoryCloneSnapshotReadback.js';

const GIT_REPOSITORY_CLONE_TIMEOUT_MS = 120_000;

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

function validateCloneTargetUrl(input: Readonly<{
    provider: CloneProviderRef;
    target: ScmRepositoryCloneTarget & { protocol: 'ssh' | 'https' };
}>): { ok: true } | { ok: false; response: ScmRepositoryCloneOutput } {
    if (input.target.url.includes('\0') || input.target.url.startsWith('-')) {
        return {
            ok: false,
            response: errorResponse(
                'Repository clone target URL is not safe to pass to Git.',
                SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            ),
        };
    }

    try {
        const parsed = new URL(input.target.url);
        const allowedSchemes = input.provider.urlSafety?.allowedSchemes?.length
            ? input.provider.urlSafety.allowedSchemes
            : ['https:'];
        if (!allowedSchemes.includes(parsed.protocol)) {
            return {
                ok: false,
                response: errorResponse(
                    'Repository clone target URL uses a scheme that is not allowed by the hosting provider.',
                    SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                ),
            };
        }
        if (parsed.password || (input.target.protocol !== 'ssh' && parsed.username)) {
            return {
                ok: false,
                response: errorResponse(
                    'Repository clone target URL must not contain embedded credentials.',
                    SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                ),
            };
        }
        return { ok: true };
    } catch {
        if (input.target.protocol === 'ssh') return { ok: true };
        return {
            ok: false,
            response: errorResponse(
                'Repository clone target URL is invalid.',
                SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            ),
        };
    }
}

function selectCloneTarget(
    description: ScmRepositoryCloneTargetDescription,
    protocol: SourceControlCloneProtocol,
    provider: CloneProviderRef,
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

    const safety = validateCloneTargetUrl({ provider, target });
    if (!safety.ok) return safety;

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
): Promise<ScmHostingProviderRuntimeServices> {
    if (deps?.runtimeServices) return deps.runtimeServices;
    const runtimeServices = readCurrentScmHostingProviderRuntimeServices();
    if (!runtimeServices) {
        throw new Error('Git repository clone operations require host-injected SCM hosting provider runtime services.');
    }
    return runtimeServices;
}

async function describeCloneTargets(input: Readonly<{
    request: ScmRepositoryCloneInput;
    deps?: GitRepositoryCloneOperationDeps;
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
            runtimeServices: await readRuntimeServices(input.deps),
        });
        return selectCloneTarget(description, input.request.protocol, registeredProvider);
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
            });
            if (!cloneTarget.ok) return cloneTarget.response;

            const finalDestination = await preflightDestination(request);
            if (!finalDestination.ok) return finalDestination.response;
            const reservedDestination = await reserveCloneDestination(finalDestination);
            if (!reservedDestination.ok) return reservedDestination.response;

            const clone = await runCommand({
                bin: 'git',
                cwd: reservedDestination.parentPath,
                args: ['clone', '--', cloneTarget.target.url, reservedDestination.cloneDestinationPath],
                timeoutMs: GIT_REPOSITORY_CLONE_TIMEOUT_MS,
                env: buildScmNonInteractiveEnv(),
            });
            if (!clone.success) {
                await cleanupPrivateCloneDestination({
                    path: reservedDestination.privateTempPath,
                    identity: reservedDestination.privateTempIdentity,
                });
                return mapCloneCommandFailure(clone);
            }

            const publishResult = await publishPrivateCloneDestination(reservedDestination);
            if (!publishResult.ok) return publishResult.response;

            const snapshot = await readClonedSnapshot({
                context,
                destinationPath: reservedDestination.finalDestinationPath,
                destinationIdentity: publishResult.destinationIdentity,
                detectRepo,
                readSnapshot,
            });
            if (isFailureResponse(snapshot)) return snapshot;

            return {
                success: true,
                destinationPath: reservedDestination.finalDestinationPath,
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
