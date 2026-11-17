import { createCanonicalJsonSigningInput, PluginError, type DatabaseEnginesServiceV1,
    type PluginServiceLaunchEnvironmentInputV1, type PluginServiceLaunchEnvironmentRuntimeV1 } from '@happier-dev/plugin-sdk';
import { decideDatabaseAccessV1, summarizeDatabaseAccessV1 } from '@happier-dev/databases';
import type { DatabaseDescriptorV1, DatabaseOperationClassV1, DatabaseOperationInputV1, DatabaseRequesterKindV1,
    DatabaseTargetsListInputV1, DatabaseTargetsListResultV1, DatabaseWorktreeTargetV1 } from '@happier-dev/database-protocol';
import { findDatabaseConnectionDescriptor, openDatabaseConnection, type DatabaseWorkbenchConnection } from './connection.js';
import type { DatabaseManualIdentity } from './manualTargets.js';

type WorktreeScope = Extract<DatabaseTargetsListInputV1['scope'], { kind: 'worktree' }>;
type Entry = Readonly<{ scope: WorktreeScope; serviceId: string; variables: readonly string[];
    readEnvironment: PluginServiceLaunchEnvironmentInputV1['readEnvironment'] }>;
type Request = Readonly<{ identity: Partial<DatabaseManualIdentity>; requester: DatabaseRequesterKindV1 | undefined;
    databaseEngines?: DatabaseEnginesServiceV1; signal?: AbortSignal }>;

function unavailable(): never { throw new PluginError({ code: 'database_target_unavailable' }); }
function admittedScope(scope: DatabaseTargetsListInputV1['scope'], identity: Request['identity']) {
    if (!identity.requesterAccount || !identity.chosenMachine) throw new PluginError({ code: 'plugin_service_unavailable' });
    if (scope.kind === 'environment' || scope.accountId !== identity.requesterAccount.accountId
        || scope.installationId !== identity.chosenMachine.installationId) return unavailable();
    if (scope.kind === 'worktree') {
        const machine = scope.workspace.kind === 'managed' ? scope.workspace.controller : scope.workspace;
        if (machine.machineId !== identity.chosenMachine.machineId) return unavailable();
    }
    return scope;
}
function scopeKey(scope: WorktreeScope): string { return createCanonicalJsonSigningInput(scope); }
function accessFacts(requester: Request['requester']) {
    if (!requester) throw new PluginError({ code: 'plugin_service_unavailable' });
    // P3 owns the decider; discovered worktree databases begin at Agents: None.
    return { person: { mayWrite: true, editingOff: false }, agentAccess: 'none' as const, requester };
}

/** Prepared originals remain at A's private reader and expire with the existing service release. */
export function createWorktreeDatabaseTargets(): Readonly<{
    launch: PluginServiceLaunchEnvironmentRuntimeV1;
    list(request: Request & Readonly<{ input: DatabaseTargetsListInputV1 }>): Promise<DatabaseTargetsListResultV1>;
    admit(request: Request & Readonly<{ input: DatabaseOperationInputV1; access: DatabaseOperationClassV1 }>): Readonly<{
        agentAccess: 'none'; access: ReturnType<typeof summarizeDatabaseAccessV1>;
    }>;
    resolve(request: Request & Readonly<{ input: DatabaseOperationInputV1; access: DatabaseOperationClassV1 }>): Promise<Readonly<{
        descriptor: DatabaseDescriptorV1; connection: DatabaseWorkbenchConnection;
    }>>;
}> {
    const entries = new Map<string, Entry>();
    const entryKey = (entry: Pick<Entry, 'scope' | 'serviceId'>) => createCanonicalJsonSigningInput([entry.scope, entry.serviceId]);
    function admittedEntry(request: Request & Readonly<{ input: DatabaseOperationInputV1; access: DatabaseOperationClassV1 }>) {
        request.signal?.throwIfAborted();
        if (request.input.target.kind !== 'worktree') return unavailable();
        const { source, ...targetScope } = request.input.target;
        const scope: WorktreeScope = { ...targetScope, kind: 'worktree' };
        admittedScope(scope, request.identity);
        if (source.kind !== 'service') return unavailable();
        const entry = entries.get(entryKey({ scope, serviceId: source.serviceId }));
        if (!entry || !entry.variables.includes(source.variable)) return unavailable();
        const decision = decideDatabaseAccessV1({ ...accessFacts(request.requester), operation: request.access });
        if (!decision.ok) throw new PluginError({ code: decision.refusal });
        return { entry, variable: source.variable };
    }
    const descriptor = (entry: Entry, variable: string, connectionString: string, request: Request): DatabaseDescriptorV1 | undefined => {
        const selected = findDatabaseConnectionDescriptor(connectionString, request.databaseEngines);
        if (!selected) return undefined;
        const target: DatabaseWorktreeTargetV1 = { ...entry.scope, kind: 'worktree',
            source: { kind: 'service', serviceId: entry.serviceId, variable } };
        const machine = entry.scope.workspace.kind === 'managed' ? entry.scope.workspace.controller : entry.scope.workspace;
        return { target, label: `${entry.serviceId} · ${variable}`, ...selected, capabilities: [...selected.capabilities],
            origin: { label: entry.serviceId, environment: 'development' },
            access: summarizeDatabaseAccessV1(accessFacts(request.requester)),
            placement: { serverId: entry.scope.workspace.serverId, accountId: entry.scope.accountId,
                machineId: machine.machineId, installationId: entry.scope.installationId } };
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
                        const selected = descriptor(entry, variable, value, request);
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
        admit(request) {
            admittedEntry(request);
            return { agentAccess: 'none', access: summarizeDatabaseAccessV1(accessFacts(request.requester)) };
        },
        async resolve(request) {
            const { entry, variable } = admittedEntry(request);
            const projection = await entry.readEnvironment();
            const connectionString = projection.projectedEnvironment[variable];
            if (connectionString === undefined) return unavailable();
            const selected = descriptor(entry, variable, connectionString, request);
            if (!selected) return unavailable();
            return { descriptor: selected,
                connection: await openDatabaseConnection({ connectionString, access: request.access,
                    signal: request.signal, databaseEngines: request.databaseEngines }) };
        },
    };
}
