import { createCanonicalJsonSigningInput, PluginError, type DatabaseEnginesServiceV1, type PluginServices,
    type PluginServiceLaunchEnvironmentInputV1, type PluginServiceLaunchEnvironmentRuntimeV1 } from '@happier-dev/plugin-sdk';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import { DatabaseAgentAccessV1Schema, type DatabaseAgentAccessV1 } from '@happier-dev/plugin-sdk/database';
import { decideDatabaseAccessV1, summarizeDatabaseAccessV1 } from '@happier-dev/databases';
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
type Entry = Readonly<{ scope: WorktreeScope; serviceId: string; variables: readonly string[];
    readEnvironment: PluginServiceLaunchEnvironmentInputV1['readEnvironment'] }>;
type LevelStore = Pick<StorageScopeService, 'get' | 'set'>;
type Request = Readonly<{ identity: Partial<DatabaseManualIdentity>; requester: DatabaseRequesterKindV1 | undefined;
    storage: LevelStore | undefined; databaseEngines?: DatabaseEnginesServiceV1;
    worktreeEnvironment?: PluginServices['worktreeEnvironment']; signal?: AbortSignal }>;

function unavailable(): never { throw new PluginError({ code: 'database_target_unavailable' }); }
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
        if (source.kind === 'sqlite_file') return unavailable();
        const entry = source.kind === 'service' ? entries.get(entryKey({ scope, serviceId: source.serviceId })) : undefined;
        if (source.kind === 'service' && !entry?.variables.includes(source.variable)) return unavailable();
        const agentAccess = await readLevel(request, target);
        const decision = decideDatabaseAccessV1({ ...accessFacts(request.requester, agentAccess), operation: request.access });
        if (!decision.ok) throw new PluginError({ code: decision.refusal });
        if (source.kind === 'env_file') {
            const value = await request.worktreeEnvironment?.readDotenv({
                workspace: target.workspace, projectKey: target.projectKey, path: source.path, variable: source.variable,
            });
            if (!value) return unavailable();
            return { target, agentAccess, readConnectionString: () => value };
        }
        if (!entry) return unavailable();
        return { target, agentAccess, async readConnectionString() {
            return (await entry.readEnvironment()).projectedEnvironment[source.variable];
        } };
    }
    const descriptor = (target: DatabaseWorktreeTargetV1, connectionString: string, request: Request,
        agentAccess: DatabaseAgentAccessV1): DatabaseDescriptorV1 | undefined => {
        const { source, workspace } = target;
        if (source.kind === 'sqlite_file') return undefined;
        const selected = findDatabaseConnectionDescriptor(connectionString, request.databaseEngines);
        if (!selected) return undefined;
        const origin = source.kind === 'service' ? source.serviceId : source.path;
        const machine = workspace.kind === 'managed' ? workspace.controller : workspace;
        return { target, label: `${origin} · ${source.variable}`, ...selected, capabilities: [...selected.capabilities],
            origin: { label: origin, environment: 'development' },
            access: summarizeDatabaseAccessV1(accessFacts(request.requester, agentAccess)),
            placement: { serverId: workspace.serverId, accountId: target.accountId,
                machineId: machine.machineId, installationId: target.installationId } };
    };
    return {
        launch: { async prepare(input) {
            if (!input.requester || !input.workspace.projectKey || input.executionPlacement.machineId !== input.workspace.machineId) return { kind: 'unchanged' };
            const readEnvironment = input.readDeclaredEnvironment ?? input.readEnvironment;
            const projection = await readEnvironment();
            const variables = Object.keys(projection.projectedEnvironment);
            if (!variables.length) return { kind: 'unchanged' };
            const scope: WorktreeScope = { kind: 'worktree', accountId: input.requester.accountId,
                installationId: input.requester.installationId, projectKey: input.workspace.projectKey,
                workspace: { serverId: input.workspace.serverId, machineId: input.workspace.machineId,
                    workspaceId: input.workspace.id, rootPath: input.workspace.rootPath } };
            const entry: Entry = { scope, serviceId: input.serviceId, variables, readEnvironment };
            const key = entryKey(entry);
            entries.set(key, entry);
            return { kind: 'replace', async release() { if (entries.get(key) === entry) entries.delete(key); } };
        } },
        async list(request) {
            request.signal?.throwIfAborted();
            const scope = admittedScope(request.input.scope, request.identity);
            const targets: DatabaseDescriptorV1[] = [];
            for (const entry of entries.values()) {
                if (scope.kind === 'project' ? entry.scope.accountId !== scope.accountId || entry.scope.installationId !== scope.installationId
                    || entry.scope.projectKey !== scope.projectKey : scopeKey(entry.scope) !== scopeKey(scope)) continue;
                const projection = await entry.readEnvironment();
                for (const variable of entry.variables) {
                    const value = projection.projectedEnvironment[variable];
                    if (value === undefined) continue;
                    try {
                        const target: DatabaseWorktreeTargetV1 = { ...entry.scope, kind: 'worktree',
                            source: { kind: 'service', serviceId: entry.serviceId, variable } };
                        const selected = descriptor(target, value, request, await readLevel(request, target));
                        if (selected) targets.push(selected);
                    }
                    catch (error) {
                        // Non-database config values are not candidates; failures carry no private URL.
                        if (!(error instanceof Error) || !('code' in error) || error.code !== 'invalid_database_connection_url') throw error;
                    }
                }
            }
            return { targets, completeness: { complete: true } };
        },
        async admit(request) {
            const { agentAccess } = await admitTarget(request);
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
                const selected = descriptor(target, connectionString, request, agentAccess);
                if (!selected) return unavailable();
                return { descriptor: selected,
                    connection: await openDatabaseConnection({ connectionString, access: request.access,
                        signal: request.signal, databaseEngines: request.databaseEngines }) };
            } catch (error) {
                if (target.source.kind !== 'env_file') throw error;
                request.signal?.throwIfAborted();
                // Driver and parser errors may contain the private file value.
                throw new PluginError({ code: 'database_target_unavailable' });
            }
        },
    };
}
