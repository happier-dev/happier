import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { StorageService, StorageServiceDeps, StorageOperationActor } from '@/storage/storageService';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import {
    HappierStorageSummaryV1Schema, MachineStorageSummaryGetInputV1Schema,
    MachineStorageCategoryListInputV1Schema, MachineStorageCategoryListResultV1Schema,
    MachineStorageSizeRefreshInputV1Schema, MachineStorageWatchInputV1Schema, MachineStorageWatchResultV1Schema,
    type HappierStorageSummaryV1,
    MachineStoragePileGetInputV1Schema, MachineStoragePileSetInputV1Schema, MachineStoragePileResultV1Schema,
    MachineStorageItemsCheckInputV1Schema, PileReviewV1Schema, MachineStorageTrashMoveInputV1Schema,
    MachineStorageDeleteNowInputV1Schema, PileApplyResultV1Schema, MachineStorageTrashEmptyInputV1Schema,
    MachineStorageTrashRestoreInputV1Schema, TrashEmptyResultV1Schema, TrashRestoreResultV1Schema,
    MachineStorageWorktreesListInputV1Schema, MachineStorageSuggestionsListInputV1Schema, MachineStorageItemsListResultV1Schema,
    MachineStorageSuggestionsDeclineInputV1Schema, MachineStorageSuggestionsDeclineResultV1Schema,
    DiskScanStateV1Schema, MachineStorageScanStartInputV1Schema, MachineStorageScanGetInputV1Schema, MachineStorageScanGetResultV1Schema,
    MachineStorageScanCancelInputV1Schema, MachineStorageScanSkipInputV1Schema, MachineStorageProtectedAddInputV1Schema, MachineStorageProtectedRemoveInputV1Schema,
} from '@happier-dev/protocol/storage/storageV1';
import { MachineResourcesPolicyMutationResultV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

export type DaemonStorageTarget = Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }>;
export type DaemonStorageRoutes = Readonly<{
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
function projectSummary(summary: HappierStorageSummaryV1, custodian: boolean): HappierStorageSummaryV1 {
    if (custodian) return summary;
    const { scanShortcuts, ...shared } = summary;
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
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'storage_item_not_collectable') {
            throw new RpcError('Storage item cannot be collected; use the reference from the served storage view', error.code);
        }
        throw error;
    }
    finally { await timeWebLatencyPhase('storage.rpc.disclosure', beforeDisclosure); }
}

export function registerDaemonStorageRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonStorageRoutes): void {
    options.reconcileTarget();
    const admission = (request: Readonly<{ serverId?: string; machineId: string }>, context?: RpcHandlerContext, custodianOnly = false) => {
        const target = options.target();
        const admitted = context?.machineAdmission;
        const custodian = !!target && admitted?.role === 'manage' && admitted.actorAccountId === target.custodianAccountId;
        const deny = (predicate: RpcAdmissionPredicate) => { context?.reportAdmissionDenial?.(predicate); return false; };
        const matches = async (detached = false) => {
            if (!target || !sameTarget(options.target(), target)) return deny('machine_target');
            if (!admitted) return deny('machine_admission');
            if (!detached && context?.signal.aborted) return deny('request_cancelled');
            if (admitted.actorAccountId.length === 0) return deny('machine_actor');
            if (admitted.role !== 'use' && admitted.role !== 'manage') return deny('machine_role');
            if (custodianOnly && !custodian) return deny('machine_custodian');
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
        const verifyCurrent = async () => {
            const verified = async () => context?.verifyMachineAdmissionCurrent && await context.verifyMachineAdmissionCurrent()
                || deny('machine_currentness');
            if (!await matches() || !await verified() || !await matches()) {
                throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
            }
        };
        const assertCurrentAuthority = async () => {
            const verified = async () => context?.verifyMachineAuthorityCurrent && await context.verifyMachineAuthorityCurrent()
                || deny('machine_authority_currentness');
            if (!await matches(true) || !await verified() || !await matches(true)) {
                throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
            }
        };
        return { target, custodian, accountId: admitted?.actorAccountId ?? '', assertCurrent, assertLocalAuthority, verifyCurrent, assertCurrentAuthority };
    };
    async function readActor(access: ReturnType<typeof admission>, context?: RpcHandlerContext, effect = false): Promise<StorageOperationActor> {
        const sessionIds = access.custodian ? undefined : new Set(await options.readOwnSessionIds(access.accountId));
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
            // Session custody may await the requester owner. Verify Home authority
            // once, after that await, at the service's actual effect boundary.
            await refreshSessionCustody();
            await (effect ? access.assertCurrentAuthority() : access.verifyCurrent());
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
            return timeWebLatencyPhase('storage.service.summary', () => service.summary({ actor, signal: context?.signal }));
        }, access.verifyCurrent);
        return HappierStorageSummaryV1Schema.parse(projectSummary(summary, access.custodian));
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
        }, access.verifyCurrent);
        return MachineStorageCategoryListResultV1Schema.parse(result);
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH, async (raw: unknown, context) => {
        const request = MachineStorageSizeRefreshInputV1Schema.parse(raw);
        const access = admission(request, context, true);
        await access.assertCurrent();
        const summary = await callStorageOwner(async () => {
            const actor = await readActor(access, context);
            const service = await options.getService(access.target!);
            await access.assertCurrent();
            return service.refresh({ actor, categoryId: request.categoryId, signal: context?.signal });
        }, access.verifyCurrent);
        return HappierStorageSummaryV1Schema.parse(summary);
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
            // below and must gather fresh protection there, never while parking.
            const first = await service.summary({ signal: context?.signal });
            await access.assertCurrent();
            const cursor = request.sinceRevision ?? first.revision;
            const parked = await parkWatch({ isNewer: () => service.revision() !== cursor,
                read: () => service.summary({ actor, signal: context?.signal }), subscribe: service.subscribe,
                signal: context?.signal, windowMs: MACHINE_WATCH_WINDOW_MS });
            const summary = parked.changed ? await parked.snapshot : undefined;
            return MachineStorageWatchResultV1Schema.parse(summary
                ? { changed: true, summary: projectSummary(summary, access.custodian) } : { changed: false });
        }, access.verifyCurrent);
    });
    function registerOperation<I extends Readonly<{ serverId?: string; machineId: string }>, O>(
        method: string, requestSchema: Readonly<{ parse(raw: unknown): I }>, responseSchema: Readonly<{ parse(raw: unknown): O }>,
        invoke: (service: StorageService, request: I, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) => Promise<unknown>,
        custodianOnly = false, effect = false,
    ) {
        rpc.registerHandler(method, async (raw: unknown, context) => {
            const request = requestSchema.parse(raw);
            const access = admission(request, context, custodianOnly);
            await timeWebLatencyPhase('storage.rpc.admission', access.assertCurrent);
            const result = await callStorageOwner(async () => {
                const actor = await timeWebLatencyPhase('storage.rpc.actor', () => readActor(access, context, effect));
                const service = await timeWebLatencyPhase('storage.rpc.service', () => options.getService(access.target!));
                await timeWebLatencyPhase('storage.rpc.current', access.assertCurrent);
                // This dispatch accepts the daemon operation. Closing a sheet or transport
                // cannot cancel an accepted cleanup; live authority remains rechecked by its owner.
                if (effect) await access.assertLocalAuthority();
                return invoke(service, request, { actor, ...(effect ? {} : { signal: context?.signal }) });
            }, effect ? access.assertCurrentAuthority : access.verifyCurrent);
            return responseSchema.parse(result);
        });
    }
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PILE_GET, MachineStoragePileGetInputV1Schema, MachineStoragePileResultV1Schema,
        (service, _request, operation) => service.pileGet(operation));
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PILE_SET, MachineStoragePileSetInputV1Schema, MachineStoragePileResultV1Schema,
        (service, request, operation) => service.pileSet(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK, MachineStorageItemsCheckInputV1Schema, PileReviewV1Schema,
        (service, request, operation) => service.itemsCheck(request.refs, operation));
    registerOperation(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, MachineStorageTrashMoveInputV1Schema, PileApplyResultV1Schema,
        (service, request, operation) => service.trashMove(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_DELETE_NOW, MachineStorageDeleteNowInputV1Schema, PileApplyResultV1Schema,
        (service, request, operation) => service.deleteNow(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, MachineStorageTrashEmptyInputV1Schema, TrashEmptyResultV1Schema,
        (service, request, operation) => service.trashEmpty(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, MachineStorageTrashRestoreInputV1Schema, TrashRestoreResultV1Schema,
        (service, request, operation) => service.trashRestore(request, operation), false, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST, MachineStorageWorktreesListInputV1Schema, MachineStorageItemsListResultV1Schema,
        (service, request, operation) => service.worktreesList(request, operation), true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST, MachineStorageSuggestionsListInputV1Schema, MachineStorageItemsListResultV1Schema,
        (service, request, operation) => service.suggestionsList(request, operation), true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE, MachineStorageSuggestionsDeclineInputV1Schema, MachineStorageSuggestionsDeclineResultV1Schema,
        (service, request, operation) => service.suggestionsDecline(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_START, MachineStorageScanStartInputV1Schema, DiskScanStateV1Schema,
        (service, request, operation) => service.scanStart(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_GET, MachineStorageScanGetInputV1Schema, MachineStorageScanGetResultV1Schema,
        (service, request, operation) => service.scanGet(request, operation), true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL, MachineStorageScanCancelInputV1Schema, DiskScanStateV1Schema,
        (service, request, operation) => service.scanCancel(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP, MachineStorageScanSkipInputV1Schema, DiskScanStateV1Schema,
        (service, request, operation) => service.scanSkip(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PROTECTED_ADD, MachineStorageProtectedAddInputV1Schema, MachineResourcesPolicyMutationResultV1Schema,
        (service, request, operation) => service.protectedAdd(request, operation), true, true);
    registerOperation(RPC_METHODS.DAEMON_STORAGE_PROTECTED_REMOVE, MachineStorageProtectedRemoveInputV1Schema, MachineResourcesPolicyMutationResultV1Schema,
        (service, request, operation) => service.protectedRemove(request, operation), true, true);
}
