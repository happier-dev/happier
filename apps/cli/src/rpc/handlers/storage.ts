import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { StorageService, StorageServiceDeps, StorageOperationActor } from '@/storage/storageService';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isPermissionError } from '@/storage/categories/filesystem';
import {
    MachineStorageSummaryGetInputV1Schema, MachineStorageCategoryListInputV1Schema,
    MachineStorageSizeRefreshInputV1Schema, MachineStorageWatchInputV1Schema,
    type HappierStorageSummaryV1, type MachineStorageWatchResultV1,
    MachineStoragePileGetInputV1Schema, MachineStoragePileSetInputV1Schema,
    MachineStorageItemsCheckInputV1Schema, MachineStorageTrashMoveInputV1Schema,
    MachineStorageDeleteNowInputV1Schema, MachineStorageTrashEmptyInputV1Schema,
    MachineStorageTrashRestoreInputV1Schema,
    MachineStorageWorktreesListInputV1Schema, MachineStorageSuggestionsListInputV1Schema,
    MachineStorageSuggestionsDeclineInputV1Schema,
    MachineStorageScanStartInputV1Schema, MachineStorageScanGetInputV1Schema,
    MachineStorageScanCancelInputV1Schema, MachineStorageScanSkipInputV1Schema, MachineStorageProtectedAddInputV1Schema, MachineStorageProtectedRemoveInputV1Schema,
} from '@happier-dev/protocol/storage/storageV1';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';
import { MachineStorageDockerPruneInputV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { runHostActionOperation, type HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

export type DaemonStorageTarget = Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }>;
export type DaemonStorageRoutes = Readonly<{
    observeActionExecution?: HostActionOperationRuntime['observeExecution'];
    target: () => DaemonStorageTarget | null;
    getService: (target: DaemonStorageTarget) => Promise<StorageService>;
    readOwnSessionIds: (accountId: string) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
    reconcileTarget: () => void;
    dispose: () => void;
}>;

function sameTarget(left: DaemonStorageTarget | null, right: DaemonStorageTarget): boolean {
    return !!left && left.serverId === right.serverId && left.machineId === right.machineId
        && left.installationId === right.installationId && left.custodianAccountId === right.custodianAccountId;
}

export function createDaemonStorageRoutes(input: Readonly<{
    target: DaemonStorageRoutes['target'];
    deps: (target: DaemonStorageTarget) => StorageServiceDeps | Promise<StorageServiceDeps>;
    readOwnSessionIds: DaemonStorageRoutes['readOwnSessionIds'];
}>): DaemonStorageRoutes {
    type Owner = { target: DaemonStorageTarget; service: Promise<StorageService>; constructed?: StorageService };
    let owner: Owner | undefined;
    let disposed = false;
    const isCurrentOwner = (current: Owner) => !disposed && owner === current && sameTarget(input.target(), current.target);
    const retire = () => {
        const prior = owner;
        owner = undefined;
        if (prior?.constructed) prior.constructed.dispose();
        else if (prior) void prior.service.then(service => service.dispose(), () => {});
    };
    return {
        target: input.target,
        readOwnSessionIds: input.readOwnSessionIds,
        reconcileTarget() {
            if (owner && !sameTarget(input.target(), owner.target)) retire();
        },
        getService(target) {
            if (disposed || !sameTarget(input.target(), target)) return Promise.reject(new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN));
            if (owner && !sameTarget(owner.target, target)) retire();
            if (!owner) {
                // Publish the owner before its queued initializer can run; never
                // capture a promise that is still inside its own assignment.
                const current: Owner = { target, service: Promise.resolve().then(async () => {
                    if (!isCurrentOwner(current)) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
                    const { createStorageService } = await import('@/storage/storageService');
                    if (!isCurrentOwner(current)) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
                    const deps = await input.deps(target);
                    if (!isCurrentOwner(current)) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
                    const created = createStorageService(deps);
                    if (!isCurrentOwner(current)) {
                        created.dispose();
                        throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
                    }
                    current.constructed = created;
                    try { await created.initialize(); }
                    catch (error) {
                        created.dispose();
                        if (!isCurrentOwner(current)) {
                            throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
                        }
                        throw error;
                    }
                    if (!isCurrentOwner(current)) {
                        created.dispose();
                        throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
                    }
                    return created;
                }) };
                owner = current;
                void current.service.catch(() => { if (owner === current) owner = undefined; });
            }
            return owner.service;
        },
        dispose() { disposed = true; retire(); },
    };
}

/** Recipients receive machine capacity and Happier totals, never another Account's paths or work. */
function projectSummary(summary: HappierStorageSummaryV1, canManage: boolean): HappierStorageSummaryV1 {
    if (canManage) return summary;
    const { scanShortcuts, docker, ...shared } = summary;
    return { ...shared, categories: [], suggestionsTop: [],
        volumes: summary.volumes.map(volume => ({ ...volume, trashBytes: 0 })),
        pile: summary.pile, trash: { count: 0, allocatedBytes: 0 },
        wholeDisk: { enabled: false, scans: [] } };
}

async function callStorageOwner<T>(invoke: () => Promise<T>, beforeDisclosure: () => Promise<void>): Promise<T> {
    try { return await invoke(); }
    catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'unauthorized') {
            throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
        }
        if (isPermissionError(error)) {
            // Catalog sizing and Trash manifests reach the same filesystem boundary.
            // Classify once here, preserving the native cause without its private path.
            throw new RpcError('Permission denied accessing storage. Restore the daemon user’s access to that volume, then retry.',
                'storage_permission_denied', projectActionFailureCauseV1(error, 'storage.owner'));
        }
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'policy_unavailable') {
            throw new RpcError('Storage policy is unavailable', error.code);
        }
        if (typeof error === 'object' && error !== null && 'code' in error
            && (error.code === 'storage_whole_disk_disabled' || error.code === 'disabled')) {
            // The scan runner can observe opt-out after the service's initial
            // policy check. Both paths carry the same public Storage refusal.
            throw new RpcError('Whole-disk scan disabled', 'storage_whole_disk_disabled');
        }
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'storage_scan_unavailable') {
            throw new RpcError('Scan unavailable', error.code);
        }
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'storage_item_not_collectable') {
            throw new RpcError('Storage item cannot be collected; use the reference from the served storage view', error.code);
        }
        throw error;
    }
    finally { await timeWebLatencyPhase('storage.rpc.disclosure', beforeDisclosure); }
}

export function registerDaemonStorageRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonStorageRoutes): void {
    options.reconcileTarget();
    const admission = (request: Readonly<{ serverId?: string; machineId: string }>, context?: RpcHandlerContext, manageOnly = false) => {
        const target = options.target();
        const admitted = context?.machineAdmission;
        const canManage = admitted?.role === 'manage';
        const deny = (predicate: RpcAdmissionPredicate) => { context?.reportAdmissionDenial?.(predicate); return false; };
        const matches = async (detached = false) => {
            if (!target || !sameTarget(options.target(), target)) return deny('machine_target');
            if (!admitted) return deny('machine_admission');
            if (!detached && context?.signal.aborted) return deny('request_cancelled');
            if (admitted.actorAccountId.length === 0) return deny('machine_actor');
            if (admitted.role !== 'use' && admitted.role !== 'manage') return deny('machine_role');
            if (manageOnly && !canManage) return deny('machine_role');
            if (!doesMachineRpcTargetMatchAdmission(request, admitted, target, context?.reportAdmissionDenial)) return false;
            if (!sameTarget(options.target(), target)) return deny('machine_target');
            if (!detached && context?.signal.aborted) return deny('request_cancelled');
            return true;
        };
        const assertCurrent = async () => {
            if (!await matches() || !await matches()) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
        };
        const assertLocalAuthority = async () => {
            if (!await matches(true) || !await matches(true)) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
        };
        return { target, canManage, accountId: admitted?.actorAccountId ?? '', assertCurrent, assertLocalAuthority };
    };
    async function readActor(access: ReturnType<typeof admission>, context?: RpcHandlerContext, effect = false): Promise<StorageOperationActor> {
        const sessionIds = access.canManage ? undefined : new Set(await options.readOwnSessionIds(access.accountId));
        await access.assertCurrent();
        const assertLocal = effect ? access.assertLocalAuthority : access.assertCurrent;
        const refreshSessionCustody = async () => {
            await assertLocal();
            if (effect && sessionIds) {
                const current = await options.readOwnSessionIds(access.accountId);
                await assertLocal();
                // Keep the owner's readonly view, but refresh Session custody
                // at the same authority boundary immediately before effects.
                sessionIds.clear();
                for (const sessionId of current) sessionIds.add(sessionId);
            }
        };
        const assertCurrentAuthority = async () => {
            // Finite operations consume dispatch admission. Keep local target and
            // Session custody checks at their native effect boundaries.
            await refreshSessionCustody();
            await assertLocal();
        };
        return { accountId: access.accountId,
            kind: context?.callerAuthority === 'present_user' && !context.sessionActionOrigin ? 'person' : 'agent',
            custodianAccountId: access.target!.custodianAccountId,
            ...(sessionIds ? { sessionIds } : {}),
            assertCurrent: refreshSessionCustody,
            assertCurrentAuthority,
        };
    }
    rpc.registerHandler(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, async (raw: unknown, context) => {
        const request = MachineStorageSummaryGetInputV1Schema.parse(raw);
        const access = admission(request, context);
        await timeWebLatencyPhase('storage.rpc.admission', access.assertCurrent);
        const summary = await callStorageOwner(async () => {
            const actor = await timeWebLatencyPhase('storage.rpc.actor', () => readActor(access, context));
            const service = await timeWebLatencyPhase('storage.rpc.service', () => options.getService(access.target!));
            await timeWebLatencyPhase('storage.rpc.current', access.assertCurrent);
            return timeWebLatencyPhase('storage.service.summary', () => service.summary({ actor, signal: context?.signal,
                ...(access.canManage ? { context: buildActionExecutorContextForRpc({ ...context,
                    actionId: 'machines.storage.summary.get', serverId: access.target!.serverId }) } : {}) }));
        }, access.assertCurrent);
        return projectSummary(summary, access.canManage);
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, async (raw: unknown, context) => {
        const request = MachineStorageCategoryListInputV1Schema.parse(raw);
        const access = admission(request, context, request.categoryId !== 'sessionFolders' && request.categoryId !== 'trash');
        await timeWebLatencyPhase('storage.rpc.admission', access.assertCurrent);
        const result = await callStorageOwner(async () => {
            const actor = await timeWebLatencyPhase('storage.rpc.actor', () => readActor(access, context));
            const service = await timeWebLatencyPhase('storage.rpc.service', () => options.getService(access.target!));
            await timeWebLatencyPhase('storage.rpc.current', access.assertCurrent);
            return timeWebLatencyPhase('storage.service.category-list', () => service.categoryList(request.categoryId, { actor, signal: context?.signal, cursor: request.cursor,
                assertCurrent: actor.assertCurrent, ...(actor.sessionIds ? { sessionIds: actor.sessionIds } : {}) }));
        }, access.assertCurrent);
        return result;
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, async (raw: unknown, context) => {
        const request = MachineStorageSizeRefreshInputV1Schema.parse(raw);
        const access = admission(request, context, true);
        await access.assertCurrent();
        const summary = await callStorageOwner(async () => {
            const actor = await readActor(access, context);
            const service = await options.getService(access.target!);
            await access.assertCurrent();
            return service.refresh({ actor, categoryId: request.categoryId, signal: context?.signal,
                context: buildActionExecutorContextForRpc({ ...context, actionId: 'machines.storage.size.refresh',
                    serverId: access.target!.serverId }) });
        }, access.assertCurrent);
        return summary;
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_STORAGE_WATCH, async (raw: unknown, context) => {
        const request = MachineStorageWatchInputV1Schema.parse(raw);
        const access = admission(request, context);
        await access.assertCurrent();
        return callStorageOwner(async () => {
            const actor = await readActor(access, context);
            const service = await options.getService(access.target!);
            await access.assertCurrent();
            // Warm only the owner snapshot. The actor projection is disclosed
            // below and follows the Storage owner's protection lifetime, never
            // gathering discarded protection while parking.
            const first = await service.summary({ signal: context?.signal });
            await access.assertCurrent();
            const cursor = request.sinceRevision ?? first.revision;
            const parked = await parkWatch({ isNewer: () => service.revision() !== cursor,
                read: () => service.summary({ actor, signal: context?.signal }), subscribe: service.subscribe,
                signal: context?.signal });
            const summary = parked.changed ? await parked.snapshot : undefined;
            return (summary
                ? { changed: true, summary: projectSummary(summary, access.canManage) } : { changed: false }) satisfies MachineStorageWatchResultV1;
        }, access.assertCurrent);
    });
    function registerOperation<I extends Readonly<{ serverId?: string; machineId: string }>, O>(
        method: string, requestSchema: Readonly<{ parse(raw: unknown): I }>,
        invoke: (service: StorageService, request: I, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) => Promise<O>,
        manageOnly = false, effect = false,
    ) {
        rpc.registerHandler(method, async (raw: unknown, context) => {
            const request = requestSchema.parse(raw);
            const access = admission(request, context, manageOnly);
            await timeWebLatencyPhase('storage.rpc.admission', access.assertCurrent);
            const result = await callStorageOwner(async () => {
                const actor = await timeWebLatencyPhase('storage.rpc.actor', () => readActor(access, context, effect));
                const service = await timeWebLatencyPhase('storage.rpc.service', () => options.getService(access.target!));
                await timeWebLatencyPhase('storage.rpc.current', access.assertCurrent);
                // This dispatch accepts the daemon operation. Closing a sheet or transport
                // cannot cancel an accepted cleanup; its owner keeps local safety and custody checks.
                if (effect) await access.assertLocalAuthority();
                return invoke(service, request, { actor, ...(effect ? {} : { signal: context?.signal }) });
            }, effect ? access.assertLocalAuthority : access.assertCurrent);
            return result;
        });
    }
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PILE_GET, MachineStoragePileGetInputV1Schema,
        (service, _request, operation) => service.pileGet(operation));
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PILE_SET, MachineStoragePileSetInputV1Schema,
        (service, request, operation) => service.pileSet(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK, MachineStorageItemsCheckInputV1Schema,
        (service, request, operation) => service.itemsCheck(request.refs, operation));
    registerOperation(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, MachineStorageTrashMoveInputV1Schema,
        (service, request, operation) => service.trashMove(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_DELETE_NOW, MachineStorageDeleteNowInputV1Schema,
        (service, request, operation) => service.deleteNow(request, operation), false, true);
    rpc.registerHandler(RPC_METHODS.DAEMON_STORAGE_DOCKER_PRUNE, async (raw: unknown, context) => {
        const request = MachineStorageDockerPruneInputV1Schema.parse(raw);
        const access = admission(request, context, true);
        await access.assertCurrent();
        const result = await callStorageOwner(async () => {
            const actor = await readActor(access, context, true);
            const service = await options.getService(access.target!);
            await access.assertLocalAuthority();
            const actionContext = buildActionExecutorContextForRpc({ ...context, actionId: 'machines.storage.docker.prune',
                serverId: access.target!.serverId });
            if (!options.observeActionExecution) return { kind: 'unsupported' as const, reason: 'native_runtime_unavailable' as const,
                removed: [], kept: [] };
            const outcome = await runHostActionOperation(options.observeActionExecution, {
                actionId: 'machines.storage.docker.prune', input: request, context: actionContext,
                execute: async current => ({ ok: true, result: await service.dockerPrune(request, { actor, context: current }) }),
            }, context);
            if (!outcome.ok) throw new RpcError(outcome.error, outcome.errorCode);
            return outcome.result;
        }, access.assertLocalAuthority);
        return result;
    });
    registerOperation(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, MachineStorageTrashEmptyInputV1Schema,
        (service, request, operation) => service.trashEmpty(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, MachineStorageTrashRestoreInputV1Schema,
        (service, request, operation) => service.trashRestore(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST, MachineStorageWorktreesListInputV1Schema,
        (service, request, operation) => service.worktreesList(request, operation), true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST, MachineStorageSuggestionsListInputV1Schema,
        (service, request, operation) => service.suggestionsList(request, operation), true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE, MachineStorageSuggestionsDeclineInputV1Schema,
        (service, request, operation) => service.suggestionsDecline(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_START, MachineStorageScanStartInputV1Schema,
        (service, request, operation) => service.scanStart(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, MachineStorageScanGetInputV1Schema,
        (service, request, operation) => service.scanGet(request, operation), true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, MachineStorageScanCancelInputV1Schema,
        (service, request, operation) => service.scanCancel(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP, MachineStorageScanSkipInputV1Schema,
        (service, request, operation) => service.scanSkip(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD, MachineStorageProtectedAddInputV1Schema,
        (service, request, operation) => service.protectedAdd(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE, MachineStorageProtectedRemoveInputV1Schema,
        (service, request, operation) => service.protectedRemove(request, operation), true, true);
}
