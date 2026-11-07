import * as React from 'react';
import { createRegistryHostV1, listRegistrySourcesV1, RegistryFetchErrorV1,
    RegistryFetchResponseV1Schema, REGISTRY_ACTION_INPUT_SCHEMAS_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, REGISTRY_FORMAT_ADAPTERS_V1,
    type RegistrySourceDescriptorV1, type RegistryFetchRequestV1, type RegistryActionIdV1,
    type RegistryFormatAdapterV1, type RegistryListPageV1,
} from '@happier-dev/protocol/registries';
import { readPromptLibraryCatalogRecordV1, updatePromptLibraryRegistrySourcesV1,
    type PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { REGISTRY_ITEMS_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/registries/registryActionIdsV1';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiRegistryHttpV1 } from './registryHttpV1';
import { projectPluginRegistrySources } from './pluginRegistrySources';
import { registrySourceRevision } from './registrySourceRevision';
import { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { invalidatePromptLibraryCatalogAfterAcknowledgedMutation } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { storage } from '@/sync/domains/state/storageStore';
import { getServerProfileById, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { readLiveMachineInventoryRows } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';
import { areCredentialsEqual } from '@/auth/storage/tokenStorage';
import { BotTemplatePreviewResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getPromptLibraryCatalogValue, subscribePromptLibraryCatalogSnapshots } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';

/** Both invocation and recovery consume this exact source's live, supplier-qualified carriers. */
function* registryCarriersForSource(scope: ServerAccountScope, source?: RegistrySourceDescriptorV1 | null,
    options?: Readonly<{ explicitRefresh?: boolean; target?: ActionExecutorContext['externalActionTarget'] }>) {
    const state = storage.getState();
    const profile = getServerProfileById(scope.serverId);
    if (!profile?.serverIdentityId) return;
    const visible = resolveVisibleMachinesForActiveServerFromState(state, scope);
    const suppliers = source?.origin.kind === 'plugin' ? source.origin.suppliers : undefined;
    const candidates = suppliers === undefined ? visible : visible.filter(machine => suppliers.includes(machine.id));
    const explicit = options?.target;
    if (explicit && explicit.kind !== 'machine') return;
    const liveRows = readLiveMachineInventoryRows<(typeof visible)[number]>({ activeServerId: '', activeMachines: [],
        machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
        profile, serverIdentityId: profile.serverIdentityId });
    const namedRetry = options?.explicitRefresh && (Boolean(explicit) || suppliers !== undefined);
    for (const machine of candidates) {
        if (explicit && machine.id !== explicit.machineId) continue;
        if (!explicit && !namedRetry && (!liveRows.has(machine) || !isMachineSelectableForFleet(scope, machine))) continue;
        const resolved = resolveFreshMachineAdministrationExecutionTarget({
            serverIdentityId: profile.serverIdentityId, machineId: machine.id,
        }, { accountScope: scope, ...(namedRetry ? { intent: 'retry' } : {}) });
        if (resolved) yield resolved.machine.id;
    }
}

/** No polling: a held needs_machine result observes only the carrier owner's recovery inputs. */
export function useRegistryCarrierRecovery(needsMachine: boolean, refresh: () => Promise<void>,
    scope: ServerAccountScope | null, sourceIds?: readonly string[], enabled = true): void {
    const idsKey = JSON.stringify(sourceIds);
    const ids = React.useMemo(() => idsKey === undefined ? undefined : JSON.parse(idsKey) as string[], [idsKey]);
    const read = React.useCallback(() => {
        if (!enabled || !needsMachine || !scope) return '';
        const sources = listRegistrySourcesV1({ record: getPromptLibraryCatalogValue(scope, 'registry-sources').value
            ?? { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: projectPluginRegistrySources(
                readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })) });
        const ready = sources.filter(source => ids === undefined || ids.includes(source.id)).flatMap(source => {
            const carriers = [...registryCarriersForSource(scope, source)];
            return carriers.length ? [[source.id, carriers]] : [];
        });
        return ready.length ? JSON.stringify([scope.serverId, scope.accountId, ready]) : '';
    }, [enabled, needsMachine, scope, ids]);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!enabled || !needsMachine || !scope) return () => {};
        const stop = [storage.subscribe(notify, { machines: true, machineListByServerId: true,
            machineListStatusByServerId: true }), subscribeMachineRequestReachability(notify, { scope }),
            subscribePromptLibraryCatalogSnapshots(notify), subscribeCommittedAppShellPluginUiProjection(notify), subscribeServerProfiles(notify)];
        return () => { for (const dispose of stop) dispose(); };
    }, [enabled, needsMachine, scope]);
    const ready = React.useSyncExternalStore(subscribe, read, read);
    const attempted = React.useRef('');
    const latest = React.useRef(refresh);
    latest.current = refresh;
    React.useEffect(() => {
        if (!enabled || !needsMachine) return;
        if (!ready) { attempted.current = ''; return; }
        if (attempted.current !== ready) {
            attempted.current = ready;
            void latest.current();
        }
    }, [enabled, needsMachine, ready]);
}

type RegistryActionInput = ReturnType<(typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1)[RegistryActionIdV1]['parse']>;
type RegistryActionOutput = ReturnType<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[RegistryActionIdV1]['parse']>;
type RegistrySessionMemo = { values: Map<string, { revision: string; value: RegistryActionOutput }>;
    refreshReads: Set<string>; rateLimitedUntil: Map<string, number>;
    credentials: LazyActionAccountContext['credentials']; endpointUrl: string };
const sessionMemos = new Map<string, RegistrySessionMemo>();
let currentScope: string | null = null;

function memoFor(account: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'credentials' | 'endpointUrl'>): RegistrySessionMemo {
    const key = JSON.stringify([account.serverId, account.accountId]);
    if (currentScope !== key) { sessionMemos.clear(); currentScope = key; }
    let memo = sessionMemos.get(key);
    if (!memo || !areCredentialsEqual(memo.credentials, account.credentials) || memo.endpointUrl !== account.endpointUrl) {
        memo = { values: new Map(), refreshReads: new Set(), rateLimitedUntil: new Map(),
            credentials: account.credentials, endpointUrl: account.endpointUrl };
        sessionMemos.set(key, memo);
    }
    return memo;
}

function registryReadKey(actionId: RegistryActionIdV1, input: RegistryActionInput, machineId?: string) {
    const key = JSON.stringify([actionId, Object.fromEntries(Object.entries(input)
        .filter(([key, value]) => key !== 'refresh' && !(key === 'query' && value === '')))]);
    return machineId === undefined ? key : `${key}:${JSON.stringify(machineId)}`;
}

/** Explicit item refresh is an owner-local memo operation, not an unapproved wire field. */
function invalidateUiRegistryReadMemoV1(scope: Readonly<{ serverId: string; accountId: string }>, actionId: 'registries.items.read' | 'registries.updates.check', input: unknown) {
    const memo = sessionMemos.get(JSON.stringify([scope.serverId, scope.accountId]));
    if (!memo) return;
    const key = registryReadKey(actionId, REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input));
    for (const candidate of memo.values.keys()) {
        if (candidate === key || candidate.startsWith(`${key}:`)) memo.values.delete(candidate);
    }
    memo.refreshReads.add(key);
}
export function invalidateUiRegistryItemMemoV1(scope: Readonly<{ serverId: string; accountId: string }>, input: unknown) {
    invalidateUiRegistryReadMemoV1(scope, 'registries.items.read', input);
}
export function invalidateUiRegistryUpdateMemoV1(scope: Readonly<{ serverId: string; accountId: string }>, input: unknown) {
    invalidateUiRegistryReadMemoV1(scope, 'registries.updates.check', input);
}

/** Compose the protocol registry owner with the captured Account's existing row CAS and Machine transport. */
async function composeUiRegistryHostV1(account: LazyActionAccountContext, port: PromptLibraryStackActionPortV1,
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
    const carriersForSource = (source?: RegistrySourceDescriptorV1 | null) => registryCarriersForSource(account, source,
        { explicitRefresh: options?.explicitRefresh, target: context.externalActionTarget });
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
        readBotTemplateOnDaemon: async (registryItem, contributionId) => {
            const result = await executeActionForSource(registryItem.sourceId, 'template.preview', {
                source: { kind: 'plugin', registryItem, contributionId },
            });
            account.assertCurrent(); context.signal?.throwIfAborted();
            if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
            const preview = BotTemplatePreviewResultV1Schema.parse(result.result);
            return { release: preview.release, source: preview.source };
        },
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
            if (source && ('packageContent' in source || source.token) && (request.op === 'list' || request.op === 'read')) {
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
            const response = await withActionAccountRequestSignal(account, context.signal, signal => machineRpcWithServerScope<unknown, RegistryFetchRequestV1>({ machineId,
                serverId: account.serverId, accountId: account.accountId, preferScoped: true, method: 'daemon.registries.fetch', payload: request,
                authorization: context.rpcSessionAuthorization, signal, operationTimeoutMs: null,
                onDispatched: account.assertCurrent }));
            account.assertCurrent(); context.signal?.throwIfAborted();
            const parsed = RegistryFetchResponseV1Schema.parse(response);
            return parsed.op === 'list' ? { ...parsed, page: { ...parsed.page, machineId } } : parsed;
        },
    });
    const executeAdmitted = async (actionId: RegistryActionIdV1, admitted: RegistryActionInput): Promise<RegistryActionOutput> => {
        if (actionId === REGISTRY_ITEMS_LIST_ACTION_ID_V1) {
            const args = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(admitted);
            const sources = (await readSources()).filter(source => source.enabled && source.kinds.includes(args.kind)
                && (args.sourceIds === undefined || args.sourceIds.includes(source.id)));
            const results = await Promise.all(sources.map(async source => {
                // Views and shelves consume the same source page. A failed sibling
                // must not invalidate healthy rows or spend their upstream budget.
                const projectListQuery = !args.cursor
                    ? (REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<typeof source.format, RegistryFormatAdapterV1>>)[source.format]?.projectListQuery
                    : undefined;
                const query = args.query;
                const project = (value: { pages: RegistryListPageV1[] }) => projectListQuery && query
                    ? { pages: value.pages.map(page => projectListQuery(page, query)) } : value;
                // Only the adapter can promise that its complete page answers a
                // query locally. Remote searches and pagination keep their operands.
                const input = { ...args, ...(projectListQuery ? { query: undefined } : {}), sourceIds: [source.id] };
                const key = registryReadKey(actionId, input, context.externalActionTarget?.kind === 'machine'
                    ? context.externalActionTarget.machineId : undefined);
                const revision = registrySourceRevision([source]);
                const held = memo.values.get(key);
                const cached = held?.revision === revision && 'pages' in held.value ? held.value : null;
                const reusable = cached?.pages.every(page => page.status.state === 'ok' || page.status.state === 'rate_limited'
                    && (page.status.retryAt === undefined || page.status.retryAt > Date.now()));
                if (cached && !args.refresh && reusable) return project(cached);
                const next = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(await host.execute(actionId, input));
                const previous = new Map(cached?.pages.map(page => [page.sourceId, page]));
                const value = { pages: next.pages.map(page => {
                    const prior = previous.get(page.sourceId);
                    return prior && page.status.state !== 'ok' && page.status.state !== 'invalid_source'
                        ? { ...page, items: prior.items, ...(prior.discovery ? { discovery: prior.discovery } : {}), nextCursor: null }
                        : page;
                }) };
                if (!input.cursor && !input.query) memo.values.set(key, { revision, value });
                return project(value);
            }));
            account.assertCurrent(); context.signal?.throwIfAborted();
            return { pages: results.flatMap(result => result.pages) };
        }
        const read = actionId === 'registries.items.read';
        const args = admitted as Record<string, unknown>;
        const appCheck = actionId === 'registries.updates.check' && 'environments' in admitted;
        const cacheable = appCheck || read;
        const sourceIds = 'sourceId' in admitted ? [admitted.sourceId] : 'sourceIds' in admitted ? admitted.sourceIds : undefined;
        const revision = cacheable ? registrySourceRevision(await readSources(), sourceIds) : '';
        const machineId = context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId
            : appCheck ? carrierForSource() : undefined;
        if (appCheck && !machineId) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
        const key = registryReadKey(actionId, admitted, machineId ?? undefined);
        const cached = memo.values.get(key);
        if (cacheable && args.refresh !== true && cached?.revision === revision) {
            account.assertCurrent(); context.signal?.throwIfAborted();
            return cached.value;
        }
        const parsed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(await host.execute(actionId, admitted));
        if (cacheable
            && (!appCheck || 'results' in parsed && parsed.results.every(item => item.upstream.state !== 'unchecked'))) {
            memo.values.set(key, { revision, value: parsed });
        }
        // A received source-row mutation ACK survives caller cancellation. Only a
        // read disclosure requires the original caller still to be current here.
        if (read || appCheck || actionId === 'registries.sources.list' || actionId === 'registries.sources.detect') {
            account.assertCurrent(); context.signal?.throwIfAborted();
        }
        return parsed;
    };
    const execute = (actionId: RegistryActionIdV1, input: unknown) => executeAdmitted(actionId,
        REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input));
    return { host: { ...host, execute, executeActionForSource, executeOnMachine }, executeAdmitted };
}

export async function createUiRegistryHostV1(account: LazyActionAccountContext, port: PromptLibraryStackActionPortV1,
    context: ActionExecutorContext, options?: Readonly<{ explicitRefresh?: boolean }>) {
    return (await composeUiRegistryHostV1(account, port, context, options)).host;
}

export function createUiRegistryActionExecuteV1(account: LazyActionAccountContext,
    port: PromptLibraryStackActionPortV1): NonNullable<ActionExecutorDeps['registryActionExecute']> {
    return async ({ actionId, input, context }) => {
        const admitted = REGISTRY_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const memo = memoFor(account), key = registryReadKey(actionId, admitted);
        const itemRefresh = memo.refreshReads.delete(key);
        return (await composeUiRegistryHostV1(account, port, context, {
            explicitRefresh: itemRefresh || actionId === 'registries.updates.check'
                || actionId === 'registries.items.list' && 'refresh' in admitted && admitted.refresh === true,
        })).executeAdmitted(actionId, admitted);
    };
}
