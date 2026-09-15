import {
    readSessionMetadataRuntimeDescriptor,
    resolvePersistedCodexVendorSessionId,
} from '@happier-dev/agents';
import { readDisplayableSessionWorkStateV1, type SessionWorkStateStatusV1 } from '@happier-dev/protocol';

import type { SessionGoalControlAdapter as GenericSessionGoalControlAdapter } from '@/session/goalControls/sessionGoalControlTypes';
import {
    isCodexAppServerInvalidParamsError,
    isCodexAppServerInvalidRequestForMethodError,
    isCodexAppServerMethodNotFoundError,
} from '../appServerCompatibility';
import type { CodexAppServerClient } from '../client/createCodexAppServerClient';
import { withCodexAppServerControlClient } from '../control/withCodexAppServerControlClient';
import {
    mergeCodexGoalIntoSessionWorkStateMetadata,
    removeCodexGoalFromSessionWorkStateMetadata,
} from '../workState';
import {
    goalNotFound,
    goalObjectiveRequired,
    goalThreadIdMissing,
    invalidGoalStatus,
    unsupportedGoalClear,
    unsupportedGoalGet,
    unsupportedGoalSet,
} from './codexAppServerGoalControlResult';
import type {
    CodexAppServerGoalControlAdapter,
    CodexAppServerGoalControlContext,
    CodexAppServerGoalControlResult,
    CodexAppServerGoalSetMutation,
} from './codexAppServerGoalControlTypes';

type MetadataRecord = Record<string, unknown>;

type CodexGoalGetResponse = Readonly<{
    goal?: unknown;
}>;

function readThreadId(metadata: unknown): string | null {
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
    const fromDescriptor = runtimeDescriptor?.vendorSessionId?.trim();
    if (fromDescriptor) return fromDescriptor;
    return resolvePersistedCodexVendorSessionId(metadata);
}

function isOlderCodexObjectiveRequiredError(error: unknown): boolean {
    return isCodexAppServerInvalidParamsError(error)
        || isCodexAppServerInvalidRequestForMethodError(error, 'thread/goal/set');
}

function readGoalFromResponse(response: unknown): unknown | null {
    if (!response || typeof response !== 'object') return null;
    if (
        typeof (response as { threadId?: unknown }).threadId === 'string'
        && typeof (response as { objective?: unknown }).objective === 'string'
        && typeof (response as { status?: unknown }).status === 'string'
    ) {
        return response;
    }
    const goal = (response as CodexGoalGetResponse).goal;
    return goal && typeof goal === 'object' ? goal : null;
}

function readGoalObjective(goal: unknown): string | null {
    if (!goal || typeof goal !== 'object') return null;
    const objective = (goal as { objective?: unknown }).objective;
    if (typeof objective !== 'string') return null;
    const trimmed = objective.trim();
    return trimmed ? trimmed : null;
}

function readCurrentGoalItem(metadata: unknown, threadId: string): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const workState = (metadata as { sessionWorkStateV1?: unknown }).sessionWorkStateV1;
    if (!workState || typeof workState !== 'object') return null;
    const items = (workState as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    return items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .find((item) => item.kind === 'goal' && (
            item.vendorRef === threadId
            || item.id === `goal:${threadId}`
            || item.id === 'goal:codex:thread'
        )) ?? null;
}

function shouldReactivateForObjectiveEdit(params: Readonly<{
    metadata: unknown;
    threadId: string;
    mutation: CodexAppServerGoalSetMutation;
}>): boolean {
    if (typeof params.mutation.objective !== 'string' || params.mutation.objective.trim().length === 0) return false;
    if (typeof params.mutation.status === 'string') return false;

    const goalItem = readCurrentGoalItem(params.metadata, params.threadId);
    if (!goalItem) return false;
    return goalItem.status === 'complete';
}

function normalizeNativeStatus(status: SessionWorkStateStatusV1 | undefined): 'active' | 'paused' | 'complete' | undefined | null {
    if (status === undefined) return undefined;
    if (status === 'active' || status === 'paused' || status === 'complete') return status;
    return null;
}

function hasMutationField(mutation: CodexAppServerGoalSetMutation): boolean {
    return typeof mutation.objective === 'string'
        || typeof mutation.status === 'string';
}

function buildGoalSetParams(params: Readonly<{
    threadId: string;
    metadata: MetadataRecord;
    mutation: CodexAppServerGoalSetMutation;
    fallbackObjective?: string;
}>): Record<string, unknown> | null {
    if (!hasMutationField(params.mutation)) return null;

    const status = normalizeNativeStatus(params.mutation.status);
    if (status === null) return null;

    const objective = typeof params.mutation.objective === 'string'
        ? params.mutation.objective.trim()
        : params.fallbackObjective;
    if (typeof params.mutation.objective === 'string' && !objective) return null;

    return {
        threadId: params.threadId,
        ...(objective ? { objective } : {}),
        ...(status ? { status } : {}),
        ...(shouldReactivateForObjectiveEdit({
            metadata: params.metadata,
            threadId: params.threadId,
            mutation: params.mutation,
        }) ? { status: 'active' } : {}),
    };
}

function successWithMetadata(metadata: MetadataRecord): CodexAppServerGoalControlResult {
    return {
        metadata,
        workState: readDisplayableSessionWorkStateV1(metadata.sessionWorkStateV1),
    };
}

async function getNativeGoal(client: CodexAppServerClient, threadId: string): Promise<unknown | null> {
    const response = await client.request('thread/goal/get', { threadId });
    return readGoalFromResponse(response);
}

async function runControl(params: CodexAppServerGoalControlContext & Readonly<{
    run: (client: CodexAppServerClient, threadId: string, metadata: MetadataRecord) => Promise<CodexAppServerGoalControlResult>;
    unsupported: () => CodexAppServerGoalControlResult;
}>): Promise<CodexAppServerGoalControlResult> {
    const metadata = params.metadata ? { ...params.metadata } : {};
    const threadId = readThreadId(metadata);
    if (!threadId) return goalThreadIdMissing();

    const controlResult = await withCodexAppServerControlClient({
        cwd: params.cwd,
        metadata,
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv,
        timeoutMs: params.timeoutMs,
        run: async (client) => await params.run(client, threadId, metadata),
    });

    if (!controlResult.ok) return params.unsupported();
    return controlResult.value;
}

async function getGoal(params: CodexAppServerGoalControlContext): Promise<CodexAppServerGoalControlResult> {
    return await runControl({
        ...params,
        unsupported: unsupportedGoalGet,
        run: async (client, threadId, metadata) => {
            try {
                const goal = await getNativeGoal(client, threadId);
                const nextMetadata = goal
                    ? mergeCodexGoalIntoSessionWorkStateMetadata(metadata, goal)
                    : removeCodexGoalFromSessionWorkStateMetadata(metadata);
                return successWithMetadata(nextMetadata);
            } catch (error) {
                if (isCodexAppServerMethodNotFoundError(error)
                    || isCodexAppServerInvalidRequestForMethodError(error, 'thread/goal/get')) {
                    return unsupportedGoalGet();
                }
                throw error;
            }
        },
    });
}

async function setGoal(
    params: CodexAppServerGoalControlContext & CodexAppServerGoalSetMutation,
): Promise<CodexAppServerGoalControlResult> {
    return await runControl({
        ...params,
        unsupported: unsupportedGoalSet,
        run: async (client, threadId, metadata) => {
            const mutation: CodexAppServerGoalSetMutation = {
                ...(typeof params.objective === 'string' ? { objective: params.objective } : {}),
                ...(typeof params.status === 'string' ? { status: params.status } : {}),
            };
            const requestParams = buildGoalSetParams({ threadId, metadata, mutation });
            if (!requestParams) {
                return typeof params.status === 'string' && normalizeNativeStatus(params.status) === null
                    ? invalidGoalStatus()
                    : goalObjectiveRequired();
            }

            try {
                const response = await client.request('thread/goal/set', requestParams);
                const goal = readGoalFromResponse(response);
                const nextMetadata = goal
                    ? mergeCodexGoalIntoSessionWorkStateMetadata(metadata, goal)
                    : removeCodexGoalFromSessionWorkStateMetadata(metadata);
                return successWithMetadata(nextMetadata);
            } catch (error) {
                if (isCodexAppServerMethodNotFoundError(error)) return unsupportedGoalSet();
                if (!isOlderCodexObjectiveRequiredError(error)) throw error;

                let goal: unknown | null;
                try {
                    goal = await getNativeGoal(client, threadId);
                } catch (getError) {
                    if (isCodexAppServerMethodNotFoundError(getError)
                        || isCodexAppServerInvalidRequestForMethodError(getError, 'thread/goal/get')) {
                        return unsupportedGoalSet();
                    }
                    throw getError;
                }
                const objective = readGoalObjective(goal);
                if (!objective) return goalNotFound();

                const retryParams = buildGoalSetParams({
                    threadId,
                    metadata,
                    mutation,
                    fallbackObjective: objective,
                });
                if (!retryParams) return goalObjectiveRequired();
                const retryResponse = await client.request('thread/goal/set', retryParams);
                const nextGoal = readGoalFromResponse(retryResponse);
                const nextMetadata = nextGoal
                    ? mergeCodexGoalIntoSessionWorkStateMetadata(metadata, nextGoal)
                    : removeCodexGoalFromSessionWorkStateMetadata(metadata);
                return successWithMetadata(nextMetadata);
            }
        },
    });
}

async function clearGoal(params: CodexAppServerGoalControlContext): Promise<CodexAppServerGoalControlResult> {
    return await runControl({
        ...params,
        unsupported: unsupportedGoalClear,
        run: async (client, threadId, metadata) => {
            try {
                await client.request('thread/goal/clear', { threadId });
                return successWithMetadata(removeCodexGoalFromSessionWorkStateMetadata(metadata));
            } catch (error) {
                if (isCodexAppServerMethodNotFoundError(error)
                    || isCodexAppServerInvalidRequestForMethodError(error, 'thread/goal/clear')) {
                    return unsupportedGoalClear();
                }
                throw error;
            }
        },
    });
}

export function createCodexAppServerGoalControlAdapter(): CodexAppServerGoalControlAdapter {
    return {
        getGoal,
        setGoal,
        clearGoal,
    };
}

const nativeGoalControlAdapter = createCodexAppServerGoalControlAdapter();

function requireCwd(
    cwd: string | null,
    unsupported: () => CodexAppServerGoalControlResult,
): string | CodexAppServerGoalControlResult {
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : unsupported();
}

export const codexAppServerGoalControlAdapter: GenericSessionGoalControlAdapter = {
    getGoal: async (params) => {
        const cwd = requireCwd(params.cwd, unsupportedGoalGet);
        if (typeof cwd !== 'string') return cwd;
        return await nativeGoalControlAdapter.getGoal({
            cwd,
            metadata: params.metadata,
        });
    },
    setGoal: async (params) => {
        const cwd = requireCwd(params.cwd, unsupportedGoalSet);
        if (typeof cwd !== 'string') return cwd;
        return await nativeGoalControlAdapter.setGoal({
            cwd,
            metadata: params.metadata,
            ...(typeof params.request.objective === 'string' ? { objective: params.request.objective } : {}),
            ...(typeof params.request.status === 'string' ? { status: params.request.status } : {}),
        });
    },
    clearGoal: async (params) => {
        const cwd = requireCwd(params.cwd, unsupportedGoalClear);
        if (typeof cwd !== 'string') return cwd;
        return await nativeGoalControlAdapter.clearGoal({
            cwd,
            metadata: params.metadata,
        });
    },
};
