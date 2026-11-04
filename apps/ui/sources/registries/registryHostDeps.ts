import { createRegistryHostV1, listRegistrySourcesV1, RegistryFetchErrorV1,
    RegistryFetchRequestV1Schema, RegistryFetchResponseV1Schema, REGISTRY_ACTION_INPUT_SCHEMAS_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1, type RegistryFetchRequestV1, type RegistryActionIdV1,
} from '@happier-dev/protocol/registries';
import { readPromptLibraryCatalogRecordV1, updatePromptLibraryRegistrySourcesV1,
    type PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiRegistryHttpV1 } from './registryHttpV1';
import { projectPluginRegistrySources } from './pluginRegistrySources';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { invalidatePromptLibraryCatalogAfterAcknowledgedMutation } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { storage } from '@/sync/domains/state/storageStore';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { readLiveMachineInventoryRows } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';

type RegistrySessionMemo = { values: Map<string, unknown>; pending: Map<string, Readonly<{ account: LazyActionAccountContext; signal?: AbortSignal; promise: Promise<unknown> }>>;
    refreshReads: Set<string>; rateLimitedUntil: Map<string, number>; sourceSignature: string | null };
const sessionMemos = new Map<string, RegistrySessionMemo>();
let currentScope: string | null = null;

function memoFor(account: Pick<LazyActionAccountContext, 'serverId' | 'accountId'>): RegistrySessionMemo {
    const key = JSON.stringify([account.serverId, account.accountId]);
    if (currentScope !== key) { sessionMemos.clear(); currentScope = key; }
    let memo = sessionMemos.get(key);
    if (!memo) { memo = { values: new Map(), pending: new Map(), refreshReads: new Set(), rateLimitedUntil: new Map(), sourceSignature: null }; sessionMemos.set(key, memo); }
    return memo;
}

function registryReadKey(actionId: RegistryActionIdV1, input: Record<string, unknown>, machineId?: string) {
    const key = JSON.stringify([actionId, Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'refresh'))]);
    return machineId === undefined ? key : `${key}:${JSON.stringify(machineId)}`;
}

/** Explicit item refresh is an owner-local memo operation, not an unapproved wire field. */
export function invalidateUiRegistryItemMemoV1(scope: Readonly<{ serverId: string; accountId: string }>, input: unknown) {
    const memo = sessionMemos.get(JSON.stringify([scope.serverId, scope.accountId]));
    if (!memo) return;
    const key = registryReadKey('registries.items.read', REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.items.read'].parse(input));
    for (const cache of [memo.values, memo.pending]) {
        for (const candidate of cache.keys()) {
            if (candidate === key || candidate.startsWith(`${key}:`)) cache.delete(candidate);
        }
    }
    memo.refreshReads.add(key);
}

/** Compose the protocol registry owner with the captured Account's existing row CAS and Machine transport. */
export async function createUiRegistryHostV1(account: LazyActionAccountContext, port: PromptLibraryStackActionPortV1,
    context: ActionExecutorContext, options?: Readonly<{ explicitRefresh?: boolean }>) {
    const [{ Platform }, { runtimeFetch }] = await Promise.all([import('react-native'), import('@/utils/system/runtimeFetch')]);
    const memo = memoFor(account);
    const readSources = async (): Promise<readonly RegistrySourceDescriptorV1[]> => {
        account.assertCurrent(); context.signal?.throwIfAborted();
        const projection = await port.readCatalog(context.signal, 'registry-sources');
        account.assertCurrent(); context.signal?.throwIfAborted();
        const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'registry-sources' });
        if (read.status !== 'ready' || read.record.key !== 'registry-sources') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        return listRegistrySourcesV1({ record: read.record.value, pluginSources: projectPluginRegistrySources(
            readCurrentAppShellPluginUiProjection({ scope: account, declarationsOnly: true })) });
    };
    const executeOnMachine = async (machineId: string, actionId: ActionId, input: unknown) => {
        const [{ executeOriginalAccountMachineAction }, { randomUUID }] = await Promise.all([
            import('@/sync/api/externalActionAccountTransport'), import('@/platform/randomUUID'),
        ]);
        account.assertCurrent(); context.signal?.throwIfAborted();
        return executeOriginalAccountMachineAction({ account, machineId, actionId, input,
            requestId: context.actionRequestId ?? randomUUID(), authority: context.authority,
            actionCaller: context.actionCaller, signal: context.signal });
    };
    const carriersForSource = function* (source?: RegistrySourceDescriptorV1 | null) {
        const state = storage.getState();
        const profile = getServerProfileById(account.serverId);
        if (!profile?.serverIdentityId) return;
        const visible = resolveVisibleMachinesForActiveServerFromState(state, account);
        const suppliers = source?.origin.kind === 'plugin' ? source.origin.suppliers : undefined;
        const candidates = suppliers === undefined ? visible : visible.filter(machine => suppliers.includes(machine.id));
        const explicit = context.externalActionTarget;
        if (explicit && explicit.kind !== 'machine') return;
        const liveRows = readLiveMachineInventoryRows<(typeof visible)[number]>({ activeServerId: '', activeMachines: [],
            machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
            profile, serverIdentityId: profile.serverIdentityId });
        const namedRetry = options?.explicitRefresh && (Boolean(explicit) || suppliers !== undefined);
        for (const machine of candidates) {
            if (explicit && machine.id !== explicit.machineId) continue;
            if (!explicit && !namedRetry && (!liveRows.has(machine) || !isMachineSelectableForFleet(account, machine))) continue;
            const resolved = resolveFreshMachineAdministrationExecutionTarget({
                serverIdentityId: profile.serverIdentityId, machineId: machine.id,
            }, { accountScope: account, ...(namedRetry ? { intent: 'retry' } : {}) });
            if (resolved) yield resolved.machine.id;
        }
    };
    const carrierForSource = (source?: RegistrySourceDescriptorV1 | null) => carriersForSource(source).next().value ?? null;
    const executeActionForSource = async (sourceId: string, actionId: ActionId, input: unknown) => {
        const source = (await readSources()).find(source => source.id === sourceId);
        if (!source) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        const machineId = carrierForSource(source);
        if (!machineId) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
        return executeOnMachine(machineId, actionId, input);
    };
    const host = createRegistryHostV1({ host: Platform.OS === 'web' ? 'web' : 'native', signal: context.signal,
        http: createUiRegistryHttpV1(runtimeFetch, context.signal, Date.now, memo.rateLimitedUntil), readSources,
        mutateSources: mutation => updatePromptLibraryRegistrySourcesV1(port, mutation, context.signal),
        updates: async filter => {
            account.assertCurrent(); context.signal?.throwIfAborted();
            const carriers = carriersForSource();
            const machineId = carriers.next().value;
            if (!machineId) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
            const checkOnMachine = async (target: string, selection: typeof filter) => {
                const result = await executeOnMachine(target, 'registries.updates.check', selection ?? {});
                account.assertCurrent(); context.signal?.throwIfAborted();
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
                const checked = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(result.result);
                return { ...checked, results: checked.results.map(item => item.kind === 'browserExtension'
                    ? { ...item, machineId: target } : item) };
            };
            // Account-owned kinds need one carrier; browser profiles belong to each Machine.
            const includeExtensions = filter?.kind === undefined || filter.kind === 'browserExtension';
            const checks = await Promise.all([
                checkOnMachine(machineId, filter),
                ...(includeExtensions ? [...carriers].map(target => checkOnMachine(target, { ...filter, kind: 'browserExtension' })) : []),
            ]);
            return { checkedAt: checks.reduce((oldest, check) => Math.min(oldest, check.checkedAt), checks[0].checkedAt),
                results: checks.flatMap(check => check.results) };
        },
        createSourceOnDaemon: async input => {
            account.assertCurrent();context.signal?.throwIfAborted();
            const machineId=carrierForSource();
            if(!machineId)throw new RegistryFetchErrorV1({state:'needs_machine'});
            const result=await executeOnMachine(machineId,'registries.sources.create',input);
            if(!result.ok)throw Object.assign(new Error(result.error),{code:result.errorCode,details:result.details});
            const created=REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.create'].parse(result.result);
            // The daemon wrote the Account row; a write from this client revalidates its own copy, this one must too.
            await invalidatePromptLibraryCatalogAfterAcknowledgedMutation({serverId:account.serverId,accountId:account.accountId},()=>account.assertCurrent());
            return created;
        },
        daemonFetch: async request => {
            account.assertCurrent(); context.signal?.throwIfAborted();
            const [sources, { machineRpcWithServerScope }] = await Promise.all([
                readSources(), import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc'),
            ]);
            const source = 'sourceId' in request ? sources.find(source => source.id === request.sourceId) : null;
            const machineId = carrierForSource(source);
            if (!machineId) return { op: 'error', status: { state: 'needs_machine' } };
            if (source?.token && (request.op === 'list' || request.op === 'read')) {
                // A raw shared-Machine request has custodian custody. The
                // incumbent Action carrier admits this exact requester's Home.
                const actionId = request.op === 'list' ? 'registries.items.list' : 'registries.items.read';
                const input = request.op === 'list' ? { kind: request.kind, sourceIds: [request.sourceId],
                    ...(request.query === undefined ? {} : { query: request.query }), ...(request.cursor === undefined ? {} : { cursor: request.cursor }) }
                    : { kind: request.kind, sourceId: request.sourceId, itemId: request.itemId,
                        ...(request.version === undefined ? {} : { version: request.version }) };
                const result = await executeOnMachine(machineId, actionId, input);
                account.assertCurrent(); context.signal?.throwIfAborted();
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
                if (actionId === 'registries.items.list') {
                    const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result.result).pages.find(page => page.sourceId === request.sourceId);
                    if (!page) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
                    return { op: 'list', page: { ...page, machineId } };
                }
                return { op: 'read', item: REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result.result).item };
            }
            if (request.op === 'files') {
                const { downloadRegistrySkillFiles } = await import('@/sync/domains/transfers/runtime/transferRuntime/families/registryTransfers');
                const downloaded = await downloadRegistrySkillFiles(machineId, { kind: 'skill', sourceId: request.sourceId,
                    itemId: request.itemId, version: request.version }, { serverId: account.serverId, signal: context.signal });
                account.assertCurrent(); context.signal?.throwIfAborted();
                if (!downloaded.ok) throw new Error(downloaded.error);
                return { op: 'files', files: downloaded.payload };
            }
            const payload: RegistryFetchRequestV1 = RegistryFetchRequestV1Schema.parse(request);
            const response = await withActionAccountRequestSignal(account, context.signal, signal => machineRpcWithServerScope<unknown, RegistryFetchRequestV1>({ machineId,
                serverId: account.serverId, accountId: account.accountId, preferScoped: true, method: 'daemon.registries.fetch', payload,
                authorization: context.rpcSessionAuthorization, signal, operationTimeoutMs: null,
                requestId: context.actionRequestId ?? undefined, onDispatched: account.assertCurrent }));
            account.assertCurrent(); context.signal?.throwIfAborted();
            const parsed = RegistryFetchResponseV1Schema.parse(response);
            return parsed.op === 'list' ? { ...parsed, page: { ...parsed.page, machineId } } : parsed;
        },
    });
    const execute = async (actionId: RegistryActionIdV1, input: unknown): Promise<unknown> => {
        const admitted = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const read = actionId === 'registries.items.read' || actionId === 'registries.items.list';
        const args = admitted as Record<string, unknown>;
        const cacheable = read && (actionId === 'registries.items.read' || !args.cursor && !args.query);
        const sourceSignature = cacheable ? JSON.stringify(await readSources()) : null;
        if (cacheable && memo.sourceSignature !== sourceSignature) {
            memo.values.clear(); memo.pending.clear(); memo.sourceSignature = sourceSignature;
        }
        const key = registryReadKey(actionId, args,
            context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : undefined);
        if (cacheable && args.refresh !== true && memo.values.has(key)) {
            account.assertCurrent(); context.signal?.throwIfAborted();
            return memo.values.get(key);
        }
        const pending = memo.pending.get(key);
        // The captured Account transport shares its initiating cancellation lifetime. Only
        // callers with that exact lifetime coalesce; another Action must not inherit its abort.
        if (cacheable && pending?.account === account && pending.signal === context.signal) {
            const result = await pending.promise;
            account.assertCurrent(); context.signal?.throwIfAborted();
            return result;
        }
        const run = host.execute(actionId, admitted).then(output => {
            const parsed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(output);
            if (cacheable && memo.sourceSignature === sourceSignature
                && (actionId !== 'registries.items.list' || REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(parsed).pages.every(page => page.status.state === 'ok'))) memo.values.set(key, parsed);
            if (!read && actionId !== 'registries.sources.list' && actionId !== 'registries.sources.detect'
                && actionId !== 'registries.updates.check') memo.values.clear();
            return parsed;
        }).finally(() => { if (memo.pending.get(key)?.promise === run) memo.pending.delete(key); });
        if (cacheable) memo.pending.set(key, { account, signal: context.signal, promise: run });
        const result = await run;
        // A received source-row mutation ACK survives caller cancellation. Only a
        // read disclosure requires the original caller still to be current here.
        if (read || actionId === 'registries.sources.list' || actionId === 'registries.sources.detect') {
            account.assertCurrent(); context.signal?.throwIfAborted();
        }
        return result;
    };
    return { ...host, execute, executeActionForSource, executeOnMachine };
}

export function createUiRegistryActionExecuteV1(account: LazyActionAccountContext,
    port: PromptLibraryStackActionPortV1): NonNullable<ActionExecutorDeps['registryActionExecute']> {
    return async ({ actionId, input, context }) => {
        const admitted = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const memo = memoFor(account), key = registryReadKey(actionId, admitted);
        const itemRefresh = memo.refreshReads.delete(key);
        return (await createUiRegistryHostV1(account, port, context, {
            explicitRefresh: itemRefresh || actionId === 'registries.updates.check'
                || actionId === 'registries.items.list' && REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.items.list'].parse(admitted).refresh === true,
        })).execute(actionId, admitted);
    };
}
