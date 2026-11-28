import { pathToFileURL } from 'node:url';
import { createCanonicalJsonSigningInput, PluginError, type DatabaseEnginesServiceV1, type PluginServices,
    type PluginServiceLaunchEnvironmentInputV1, type PluginServiceLaunchEnvironmentRuntimeV1 } from '@happier-dev/plugin-sdk';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import { DatabaseAgentAccessV1Schema, type DatabaseAgentAccessV1 } from '@happier-dev/plugin-sdk/database';
import { builtinDatabaseConnectionEngine, DatabaseConnectionUrlError, decideDatabaseAccessV1, summarizeDatabaseAccessV1 } from '@happier-dev/databases';
import type {
    DatabaseDescriptorV1,
    DatabaseOperationClassV1,
    DatabaseOperationInputV1,
    DatabaseRequesterKindV1,
    DatabaseTargetsListInputV1,
    DatabaseTargetsListResultV1,
    DatabaseWorktreeTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { findDatabaseConnectionDescriptor, openDatabaseConnection, type DatabaseWorkbenchConnection } from './connection.js';
import type { DatabaseManualIdentity } from './manualTargets.js';

type WorktreeScope = Extract<DatabaseTargetsListInputV1['scope'], { kind: 'worktree' }>;
type Entry = Readonly<{ scope: WorktreeScope; serviceId: string; serviceName?: string; variables: readonly string[];
    readEnvironment: PluginServiceLaunchEnvironmentInputV1['readEnvironment'] }>;
type LevelStore = Pick<StorageScopeService, 'get' | 'set'>;
type Request = Readonly<{ identity: Partial<DatabaseManualIdentity>; requester: DatabaseRequesterKindV1 | undefined;
    storage: LevelStore | undefined; databaseEngines?: DatabaseEnginesServiceV1;
    worktreeEnvironment?: PluginServices['worktreeEnvironment']; signal?: AbortSignal }>;

function unavailable(): never { throw new PluginError({ code: 'database_target_unavailable' }); }
function selectableDotenvConnectionString(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        // Local files require a contained-file selection before the driver can open them.
        return builtinDatabaseConnectionEngine(value) === 'sqlite' ? undefined : value;
    } catch (error) {
        if (!(error instanceof DatabaseConnectionUrlError)) throw error;
        return undefined;
    }
}
function admittedScope(scope: DatabaseTargetsListInputV1['scope'], identity: Request['identity']) {
    if (!identity.requesterAccount || !identity.chosenMachine) throw new PluginError({
        code: 'plugin_service_unavailable',
        message: 'Database discovery requires the admitted Account and Machine identity. Reconnect the Machine and retry the database action.',
        details: { reason: 'database_host_identity_unavailable',
            missing: [...(!identity.requesterAccount ? ['requesterAccount'] : []), ...(!identity.chosenMachine ? ['chosenMachine'] : [])],
            recovery: 'Reconnect the Machine and retry the database action.' },
        remediation: { kind: 'retry' },
    });
    if (scope.kind === 'environment' || scope.accountId !== identity.requesterAccount.accountId
        || scope.installationId !== identity.chosenMachine.installationId) return unavailable();
    if (scope.kind === 'worktree') {
        const machine = scope.workspace.kind === 'managed' ? scope.workspace.controller : scope.workspace;
        if (machine.machineId !== identity.chosenMachine.machineId) return unavailable();
    }
    return scope;
}
function scopeKey(scope: WorktreeScope): string { return createCanonicalJsonSigningInput(scope); }
function accessFacts(requester: Request['requester'], agentAccess: DatabaseAgentAccessV1) {
    if (!requester) throw new PluginError({ code: 'plugin_service_unavailable' });
    // Whoever runs the worktree may write it (P3); the agent level is this Machine's stored choice.
    return { person: { mayWrite: true, editingOff: false }, agentAccess, requester };
}
/** P3 A1: a worktree database starts at Read & write (asks first); the executing daemon hands this level to
 * the approval applier (F10), so agent writes ask even over the person's Allow. Its owner changes it. */
const DEFAULT_WORKTREE_AGENT_ACCESS: DatabaseAgentAccessV1 = 'readWriteAsk';
const levelKey = (target: DatabaseWorktreeTargetV1) => `worktree-access/v1/${encodeURIComponent(createCanonicalJsonSigningInput(target))}`;
function levelStore(request: Request): LevelStore {
    if (!request.storage) throw new PluginError({ code: 'plugin_service_unavailable' });
    return request.storage;
}
async function readLevel(request: Request, target: DatabaseWorktreeTargetV1): Promise<DatabaseAgentAccessV1> {
    const stored = DatabaseAgentAccessV1Schema.safeParse(await levelStore(request).get(levelKey(target), { signal: request.signal }));
    return stored.success ? stored.data : DEFAULT_WORKTREE_AGENT_ACCESS;
}
function worktreeTarget(target: DatabaseOperationInputV1['target']): DatabaseWorktreeTargetV1 {
    return target.kind === 'worktree' ? target : unavailable();
}

/** Prepared originals remain at A's private reader and expire with the existing service release. */
export function createWorktreeDatabaseTargets(): Readonly<{
    launch: PluginServiceLaunchEnvironmentRuntimeV1;
    list(request: Request & Readonly<{ input: DatabaseTargetsListInputV1 }>): Promise<DatabaseTargetsListResultV1>;
    admit(request: Request & Readonly<{ input: DatabaseOperationInputV1; access: DatabaseOperationClassV1 }>): Promise<Readonly<{
        agentAccess: DatabaseAgentAccessV1; access: ReturnType<typeof summarizeDatabaseAccessV1>;
    }>>;
    /** The one writer of a worktree database's agent level, admitted for the worktree's own Account. */
    setAccess(request: Request & Readonly<{ target: DatabaseWorktreeTargetV1; agentAccess: DatabaseAgentAccessV1 }>): Promise<DatabaseAgentAccessV1>;
    resolve(request: Request & Readonly<{ input: DatabaseOperationInputV1; access: DatabaseOperationClassV1 }>): Promise<Readonly<{
        descriptor: DatabaseDescriptorV1; connection: DatabaseWorkbenchConnection;
    }>>;
}> {
    const entries = new Map<string, Entry>();
    const entryKey = (entry: Pick<Entry, 'scope' | 'serviceId'>) => createCanonicalJsonSigningInput([entry.scope, entry.serviceId]);
    async function admitTarget(request: Request & Readonly<{ input: DatabaseOperationInputV1; access: DatabaseOperationClassV1 }>) {
        request.signal?.throwIfAborted();
        const target = worktreeTarget(request.input.target);
        const { source, ...scope } = target;
        admittedScope(scope, request.identity);
        const entry = source.kind === 'service' ? entries.get(entryKey({ scope, serviceId: source.serviceId })) : undefined;
        if (source.kind === 'service' && !entry?.variables.includes(source.variable)) return unavailable();
        const agentAccess = await readLevel(request, target);
        const decision = decideDatabaseAccessV1({ ...accessFacts(request.requester, agentAccess), operation: request.access });
        if (!decision.ok) throw new PluginError({ code: decision.refusal });
        if (source.kind === 'sqlite_file') {
            return { target, agentAccess, async readConnectionString() {
                const file = await request.worktreeEnvironment?.resolveExistingFile?.({
                    workspace: target.workspace, projectKey: target.projectKey, path: source.path,
                });
                return file === undefined ? unavailable() : pathToFileURL(file).href;
            } };
        }
        if (source.kind === 'env_file') {
            return { target, agentAccess, async readConnectionString() {
                const value = await request.worktreeEnvironment?.readDotenv({
                    workspace: target.workspace, projectKey: target.projectKey, path: source.path, variable: source.variable,
                });
                return selectableDotenvConnectionString(value) ?? unavailable();
            } };
        }
        if (!entry) return unavailable();
        return { target, agentAccess, async readConnectionString() {
            return (await entry.readEnvironment()).projectedEnvironment[source.variable];
        } };
    }
    const descriptor = async (target: DatabaseWorktreeTargetV1, connectionString: string, request: Request,
        admittedAccess?: DatabaseAgentAccessV1): Promise<DatabaseDescriptorV1 | undefined> => {
        const { source, ...scope } = target;
        const { workspace } = scope;
        const selected = findDatabaseConnectionDescriptor(connectionString, request.databaseEngines);
        if (!selected) return undefined;
        const agentAccess = admittedAccess ?? await readLevel(request, target);
        // A service reads by its admitted name; its id (a native service's is a hash) only when it has none.
        const origin = source.kind === 'service'
            ? entries.get(entryKey({ scope, serviceId: source.serviceId }))?.serviceName ?? source.serviceId
            : source.path;
        const machine = workspace.kind === 'managed' ? workspace.controller : workspace;
        const label = source.kind === 'sqlite_file' ? source.path : `${origin} · ${source.variable}`;
        return { target, label, ...selected, capabilities: [...selected.capabilities],
            origin: { label: origin, environment: 'development' },
            access: summarizeDatabaseAccessV1(accessFacts(request.requester, agentAccess)),
            placement: { serverId: workspace.serverId, accountId: target.accountId,
                machineId: machine.machineId, installationId: target.installationId } };
    };
    const describeCandidate = async (target: DatabaseWorktreeTargetV1, value: string, request: Request) => {
        try {
            return await descriptor(target, value, request);
        }
        catch (error) {
            // Non-database config values are not candidates; failures carry no private URL.
            if (!(error instanceof DatabaseConnectionUrlError)) throw error;
            return undefined;
        }
    };
    return {
        launch: { providesWorktreeDatabaseMembers: true, async prepare(input) {
            if (!input.requester || !input.workspace.projectKey || input.executionPlacement.machineId !== input.workspace.machineId) return { kind: 'unchanged' };
            const readEnvironment = input.readDeclaredEnvironment ?? input.readEnvironment;
            const projection = await readEnvironment();
            const variables = Object.keys(projection.projectedEnvironment);
            if (!variables.length) return { kind: 'unchanged' };
            const scope: WorktreeScope = { kind: 'worktree', accountId: input.requester.accountId,
                installationId: input.requester.installationId, projectKey: input.workspace.projectKey,
                workspace: { serverId: input.workspace.serverId, machineId: input.workspace.machineId,
                    workspaceId: input.workspace.id, rootPath: input.workspace.rootPath } };
            const entry: Entry = { scope, serviceId: input.serviceId, ...(input.serviceName ? { serviceName: input.serviceName } : {}),
                variables, readEnvironment };
            const key = entryKey(entry);
            entries.set(key, entry);
            return { kind: 'unchanged',
                get worktreeDatabaseMembers() {
                    return Object.entries(projection.projectedEnvironment).flatMap(([variable, value]) => {
                        try {
                            if (findDatabaseConnectionDescriptor(value)) return [{ ...scope,
                                source: { kind: 'service' as const, serviceId: entry.serviceId, variable } }];
                        } catch (error) {
                            if (!(error instanceof DatabaseConnectionUrlError)) throw error;
                        }
                        return [];
                    });
                },
                async release() { if (entries.get(key) === entry) entries.delete(key); } };
        } },
        async list(request) {
            request.signal?.throwIfAborted();
            const scope = admittedScope(request.input.scope, request.identity);
            const targets: DatabaseDescriptorV1[] = [];
            const launchedVariables = new Set<string>();
            for (const entry of entries.values()) {
                if (scope.kind === 'project' ? entry.scope.accountId !== scope.accountId || entry.scope.installationId !== scope.installationId
                    || entry.scope.projectKey !== scope.projectKey : scopeKey(entry.scope) !== scopeKey(scope)) continue;
                const projection = await entry.readEnvironment();
                for (const variable of entry.variables) {
                    const value = projection.projectedEnvironment[variable];
                    if (value === undefined) continue;
                    const selected = await describeCandidate({ ...entry.scope,
                        source: { kind: 'service', serviceId: entry.serviceId, variable } }, value, request);
                    if (!selected) continue;
                    launchedVariables.add(variable);
                    targets.push(selected);
                }
            }
            if (scope.kind === 'worktree' && request.worktreeEnvironment) {
                const candidates = await request.worktreeEnvironment.listDotenv({ workspace: scope.workspace, projectKey: scope.projectKey });
                for (const { path, variable, value } of candidates) {
                    if (launchedVariables.has(variable)) continue;
                    const connectionString = selectableDotenvConnectionString(value);
                    if (!connectionString) continue;
                    const selected = await describeCandidate({ ...scope, source: { kind: 'env_file', path, variable } }, connectionString, request);
                    if (selected) targets.push(selected);
                }
            }
            return { targets, completeness: { complete: true } };
        },
        async admit(request) {
            const { agentAccess, target, readConnectionString } = await admitTarget(request);
            // A held demand already owns its credential and validates its captured target.
            if (target.source.kind !== 'service' && request.input.subscriptionId === undefined) {
                await readConnectionString();
            }
            return { agentAccess, access: summarizeDatabaseAccessV1(accessFacts(request.requester, agentAccess)) };
        },
        async setAccess(request) {
            request.signal?.throwIfAborted();
            const { source: _source, ...targetScope } = request.target;
            admittedScope({ ...targetScope, kind: 'worktree' }, request.identity);
            if (await readLevel(request, request.target) !== request.agentAccess) {
                await levelStore(request).set(levelKey(request.target), request.agentAccess, { signal: request.signal });
            }
            return request.agentAccess;
        },
        async resolve(request) {
            const { target, readConnectionString, agentAccess } = await admitTarget(request);
            const connectionString = await readConnectionString();
            if (connectionString === undefined) return unavailable();
            try {
                const selected = await descriptor(target, connectionString, request, agentAccess);
                if (!selected) return unavailable();
                return { descriptor: selected,
                    connection: await openDatabaseConnection({ connectionString, access: request.access,
                        signal: request.signal, databaseEngines: request.databaseEngines }) };
            } catch (error) {
                if (target.source.kind === 'service') throw error;
                request.signal?.throwIfAborted();
                // Driver and parser errors may contain the private file value.
                throw new PluginError({ code: 'database_target_unavailable' });
            }
        },
    };
}
