import {
    ApprovalRequestV1Schema,
    type ApprovalRequestV1,
} from '@happier-dev/protocol';
import {
    ACTION_ID_FAMILIES_V1,
    ActionIdSchema,
    getActionSpec,
    type ActionId,
} from '@happier-dev/protocol/actions';
import type {
    PluginContextV1,
    PluginSettingsFieldDescriptorV1,
    SubscriptionV1,
} from '@happier-dev/plugin-sdk';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { readCredentials } from '@/persistence';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import {
    createPluginReviewCommentsService,
    type ReviewCommentActionExecutor,
} from '@/agent/reviews/comments/pluginApi';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import {
    isRecord,
    readOptionalFiniteNumber,
    readTrimmedString,
} from './values';

export type { ReviewCommentActionExecutor };

type PluginApprovalRuntimeScope = Readonly<{
    sessionId?: string | null;
    serverId?: string | null;
}>;

function createUnavailablePluginActionMethod(actionId: string): (input: unknown) => Promise<never> {
    return async (_input: unknown): Promise<never> => {
        throw new Error(`Plugin action '${actionId}' is not available in this runtime context`);
    };
}

function parseApprovalRequestInput(input: unknown): Readonly<{
    actionId: ActionId;
    args: unknown;
    summary: string;
    surface: string | null;
    preview: unknown;
}> {
    if (!isRecord(input)) {
        throw new Error('ctx.actions.approvals.request requires an object input');
    }
    const actionId = readTrimmedString(input.actionId);
    const parsedActionId = actionId ? ActionIdSchema.safeParse(actionId) : null;
    if (!parsedActionId?.success) {
        throw new Error('ctx.actions.approvals.request requires a valid actionId');
    }
    if ((ACTION_ID_FAMILIES_V1.approvals as readonly string[]).includes(parsedActionId.data)) {
        throw new Error('ctx.actions.approvals.request cannot create approval-control approvals');
    }
    const summary = readTrimmedString(input.summary);
    if (!summary) {
        throw new Error('ctx.actions.approvals.request requires a non-empty summary');
    }
    return {
        actionId: parsedActionId.data,
        args: Object.prototype.hasOwnProperty.call(input, 'args') ? input.args : {},
        summary,
        surface: readTrimmedString(input.surface),
        preview: input.preview,
    };
}

function parseApprovalArtifactId(input: unknown): string {
    const artifactId = readTrimmedString(input);
    if (!artifactId) {
        throw new Error('ctx.actions.approvals.get requires a non-empty artifact id');
    }
    return artifactId;
}

function parseApprovalListInput(input: unknown): Readonly<{
    status: ApprovalRequestV1['status'] | null;
    limit: number | null;
}> {
    if (input == null) {
        return { status: null, limit: null };
    }
    if (!isRecord(input)) {
        throw new Error('ctx.actions.approvals.list requires an object input when provided');
    }
    const rawStatus = readTrimmedString(input.status);
    const status = rawStatus === 'open'
        || rawStatus === 'approved'
        || rawStatus === 'rejected'
        || rawStatus === 'executed'
        || rawStatus === 'failed'
        || rawStatus === 'canceled'
        ? rawStatus
        : null;
    const limit = readOptionalFiniteNumber(input.limit);
    return { status, limit };
}

export function createPluginContextActionsService(params: Readonly<{
    pluginId: string;
    readScope: () => PluginApprovalRuntimeScope;
}>): PluginContextV1['actions'] {
    const loadApprovalsStore = async () => {
        const credentials = await readCredentials();
        if (!credentials) {
            throw new Error('ctx.actions.approvals requires authenticated approval credentials');
        }
        return createCliApprovalsArtifactStore({ credentials });
    };
    return Object.freeze({
        approvals: Object.freeze({
            request: async (input: unknown) => {
                const requestInput = parseApprovalRequestInput(input);
                const spec = getActionSpec(requestInput.actionId);
                const args = spec.inputSchema.safeParse(requestInput.args);
                if (!args.success) {
                    throw new Error('ctx.actions.approvals.request action args are invalid for actionId');
                }
                const now = Date.now();
                const scope = params.readScope();
                const request = ApprovalRequestV1Schema.parse({
                    v: 1,
                    status: 'open',
                    createdAtMs: now,
                    updatedAtMs: now,
                    createdBy: {
                        surface: 'system',
                        agentId: params.pluginId,
                        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
                    },
                    ...(requestInput.surface ? { requestedSurface: requestInput.surface } : {}),
                    ...(spec.approval ? { approval: spec.approval } : {}),
                    actionId: requestInput.actionId,
                    actionArgs: args.data,
                    summary: requestInput.summary,
                    ...(requestInput.preview !== undefined ? { preview: requestInput.preview } : {}),
                });
                const store = await loadApprovalsStore();
                const result = await store.approvalsCreate({
                    request,
                    serverId: scope.serverId ?? null,
                });
                return { approvalRequestId: result.artifactId };
            },
            get: async (input: string) => {
                const artifactId = parseApprovalArtifactId(input);
                const scope = params.readScope();
                const store = await loadApprovalsStore();
                return await store.approvalsGet({
                    artifactId,
                    serverId: scope.serverId ?? null,
                });
            },
            list: async (input: Readonly<{ status?: ApprovalRequestV1['status'] | null; limit?: number | null }> | undefined) => {
                const listInput = parseApprovalListInput(input);
                const scope = params.readScope();
                const store = await loadApprovalsStore();
                return await store.approvalsList({
                    status: listInput.status,
                    limit: listInput.limit,
                    serverId: scope.serverId ?? null,
                });
            },
        }),
        scm: Object.freeze({
            pullRequest: Object.freeze({
                list: createUnavailablePluginActionMethod('scm.pullRequest.list'),
                get: createUnavailablePluginActionMethod('scm.pullRequest.get'),
                openOrReuse: createUnavailablePluginActionMethod('scm.pullRequest.openOrReuse'),
                openCompose: createUnavailablePluginActionMethod('scm.pullRequest.openCompose'),
                checkout: createUnavailablePluginActionMethod('scm.pullRequest.checkout'),
                prepareWorktree: createUnavailablePluginActionMethod('scm.pullRequest.prepareWorktree'),
                runStacked: createUnavailablePluginActionMethod('scm.pullRequest.runStacked'),
            }),
            repository: Object.freeze({
                clone: createUnavailablePluginActionMethod('scm.repository.clone'),
                init: createUnavailablePluginActionMethod('scm.repository.init'),
                removeIndexLock: createUnavailablePluginActionMethod('scm.repository.removeIndexLock'),
            }),
            hostingRepository: Object.freeze({
                describePublishTargets: createUnavailablePluginActionMethod('scm.hostingRepository.describePublishTargets'),
                publish: createUnavailablePluginActionMethod('scm.hostingRepository.publish'),
            }),
            diffSummary: Object.freeze({
                generate: createUnavailablePluginActionMethod('scm.diffSummary.generate'),
            }),
        }),
    });
}

function createNoopPluginSubscription(): SubscriptionV1 {
    return Object.freeze({
        unsubscribe: () => undefined,
    });
}

export function createUnavailablePluginSubagentsService(): PluginContextV1['sessions']['subagents'] {
    const rejectWrite = async (): Promise<never> => {
        throw new Error('ctx.sessions.subagents is unavailable until the owning subagent packet binds a host adapter');
    };
    return Object.freeze({
        list: async () => Object.freeze([]),
        get: async () => null,
        watch: () => createNoopPluginSubscription(),
        upsert: rejectWrite,
        updateStatus: rejectWrite,
        complete: rejectWrite,
    });
}

export function createUnavailablePluginExternalSessionsService(): PluginContextV1['sessions']['external'] {
    const unavailable = 'ctx.sessions.external is unavailable until the owning external-session packet binds a host adapter';
    return Object.freeze({
        listCandidates: async () => Object.freeze({
            candidates: Object.freeze([]),
            nextCursor: null,
        }),
        attach: async () => Object.freeze({
            ok: false,
            error: unavailable,
        }),
        takeover: async () => Object.freeze({
            ok: false,
            errorCode: 'capability_unsupported',
            error: unavailable,
        }),
        pageTranscript: async () => Object.freeze({
            ok: false,
            errorCode: 'agent_unavailable',
            error: unavailable,
        }),
        readAfterTranscript: async () => Object.freeze({
            ok: false,
            errorCode: 'agent_unavailable',
            error: unavailable,
        }),
        followTranscript: () => createNoopPluginSubscription(),
    });
}

export function createPluginReviewsService(params: Readonly<{
    pluginId: string;
    executeReviewCommentAction: ReviewCommentActionExecutor;
    resolveSnapshot: Parameters<typeof createPluginReviewCommentsService>[0]['resolveSnapshot'];
}>): PluginContextV1['reviews'] {
    return Object.freeze({
        comments: createPluginReviewCommentsService({
            execute: params.executeReviewCommentAction,
            principalActor: { kind: 'plugin', pluginId: params.pluginId },
            resolveSnapshot: params.resolveSnapshot,
        }),
    });
}

export function createProductionReviewCommentActionExecutor(): ReviewCommentActionExecutor {
    return async (actionId, input, options) => {
        const credentials = await readCredentials().catch(() => null);
        if (!credentials) {
            throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        }
        const executor = createCliReviewCommentActionExecutorFromCredentials({ credentials });
        return await executor(actionId, input, options);
    };
}

export function readPluginSettingsDescriptors(params: Readonly<{
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginId: string;
}>): readonly PluginSettingsFieldDescriptorV1[] {
    const settings = params.runtimeRegistry?.contributes.settings ?? [];
    return Object.freeze(settings
        .filter((contribution) => contribution.pluginId === params.pluginId)
        .flatMap((contribution) => contribution.definition.fields));
}
