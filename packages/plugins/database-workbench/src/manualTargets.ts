import { createCanonicalJsonSigningInput, isRecord, PluginError } from '@happier-dev/plugin-sdk';
import { decideDatabaseAccessV1, summarizeDatabaseAccessV1 } from '@happier-dev/databases';
import {
    DatabaseAgentAccessV1Schema,
    DatabaseEngineIdV1Schema,
    DatabaseManualTargetV1Schema,
} from '@happier-dev/plugin-sdk/database';
import type { DatabaseEnginesServiceV1 } from '@happier-dev/plugin-sdk';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import type {
    DatabaseAgentAccessV1,
    DatabaseEngineIdV1,
    DatabaseDescriptorV1,
    DatabaseManualTargetV1,
    DatabaseOperationClassV1,
    DatabaseOperationInputV1,
    DatabaseRequesterKindV1,
    DatabaseTargetsListInputV1,
    DatabaseTargetsListResultV1,
    DatabaseAccessSummaryV1,
    DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import type { DatabaseWorkbenchConnection } from './connection.js';
import { databaseEngineCapabilities } from './capabilities.js';

/** Captured host facts; no field is supplied by a database target operand. */
export type DatabaseManualIdentity = Readonly<{
    requesterAccount: Readonly<{ accountId: string }>;
    chosenMachine: Readonly<{ machineId: string; installationId: string }>;
}>;
export type DatabaseManualScope = Extract<DatabaseTargetsListInputV1['scope'], { kind: 'worktree' }>;
type ManualSecrets = Pick<SecretsService, 'readSavedSecret'>;

export interface DatabaseManualTargets {
    list(input: Readonly<{ input: DatabaseTargetsListInputV1; requester: DatabaseRequesterKindV1 | undefined; signal?: AbortSignal }>): Promise<DatabaseTargetsListResultV1>;
    resolve(input: Readonly<{
        input: DatabaseOperationInputV1; access: DatabaseOperationClassV1; requester: DatabaseRequesterKindV1 | undefined;
        secrets: ManualSecrets; signal?: AbortSignal;
    }>): Promise<Readonly<{ descriptor: DatabaseDescriptorV1; connection: DatabaseWorkbenchConnection }>>;
    connect(input: Readonly<{
        scope: DatabaseTargetsListInputV1['scope']; savedSecretId: string; label: string; agentAccess: DatabaseAgentAccessV1;
        secrets: ManualSecrets; signal?: AbortSignal;
    }>): Promise<DatabaseDescriptorV1>;
    forget(input: Readonly<{ target: DatabaseManualTargetV1; signal?: AbortSignal }>): Promise<void>;
    /** This request's access from the stored level; no Saved Secret read and no connection. */
    admit(input: Readonly<{
        target: DatabaseTargetV1; access: DatabaseOperationClassV1; requester: DatabaseRequesterKindV1 | undefined; signal?: AbortSignal;
    }>): Promise<Readonly<{ agentAccess: DatabaseAgentAccessV1; access: DatabaseAccessSummaryV1 }>>;
    setAccess(input: Readonly<{ target: DatabaseManualTargetV1; agentAccess: DatabaseAgentAccessV1; signal?: AbortSignal }>): Promise<DatabaseAgentAccessV1>;
}

type ManualRecord = Readonly<{
    target: DatabaseManualTargetV1; label: string; engine: DatabaseEngineIdV1; agentAccess: DatabaseAgentAccessV1;
}>;
const manualTargetsPrefix = 'manual-targets/v1/';

function parseRecord(value: unknown): ManualRecord | undefined {
    if (!isRecord(value) || typeof value.label !== 'string') return;
    const target = DatabaseManualTargetV1Schema.safeParse(value.target);
    const engine = DatabaseEngineIdV1Schema.safeParse(value.engine);
    const agentAccess = DatabaseAgentAccessV1Schema.safeParse(value.agentAccess);
    if (target.success && engine.success && agentAccess.success) {
        return { target: target.data, label: value.label, engine: engine.data, agentAccess: agentAccess.data };
    }
}

function targetScope(target: DatabaseManualTargetV1): DatabaseManualScope {
    return { kind: 'worktree', accountId: target.accountId, installationId: target.installationId, projectKey: target.projectKey, workspace: target.workspace };
}

function scopePrefix(scope: DatabaseManualScope): string {
    return `${manualTargetsPrefix}${encodeURIComponent(createCanonicalJsonSigningInput(scope))}/`;
}

function targetKey(target: DatabaseManualTargetV1): string {
    return `${scopePrefix(targetScope(target))}${encodeURIComponent(target.savedSecretId)}`;
}

export function createManualDatabaseTargets(options: Readonly<{
    storage: Pick<StorageScopeService, 'get' | 'set' | 'delete' | 'list'> | undefined;
    identity: Partial<DatabaseManualIdentity> | undefined;
    databaseEngines?: DatabaseEnginesServiceV1;
}>): DatabaseManualTargets {
    const { storage, identity } = options;
    const requesterAccount = identity?.requesterAccount;
    const chosenMachine = identity?.chosenMachine;
    if (!storage || !requesterAccount || !chosenMachine) {
        throw new PluginError({ code: 'plugin_service_unavailable', message: 'Database host identity and daemon storage are unavailable.' });
    }
    const daemonStorage = storage;
    const accountId = requesterAccount.accountId;
    const hostMachine = chosenMachine;
    function unavailable(): never { throw new PluginError({ code: 'database_target_unavailable' }); }
    function requireRequester(requester: DatabaseRequesterKindV1 | undefined): DatabaseRequesterKindV1 {
        if (!requester) throw new PluginError({ code: 'plugin_service_unavailable', message: 'Database requester identity is unavailable.' });
        return requester;
    }
    function admitHostScope(scope: Readonly<{ accountId: string; installationId: string }>): void {
        if (scope.accountId !== accountId || scope.installationId !== hostMachine.installationId) return unavailable();
    }
    function admitScope(scope: DatabaseTargetsListInputV1['scope']): DatabaseManualScope {
        if (scope.kind !== 'worktree') return unavailable();
        admitHostScope(scope);
        const machine = scope.workspace.kind === 'managed' ? scope.workspace.controller : scope.workspace;
        if (machine.machineId !== hostMachine.machineId || ('installationId' in machine && machine.installationId !== hostMachine.installationId)) return unavailable();
        return scope;
    }
    function accessFacts(record: ManualRecord, requester: DatabaseRequesterKindV1) {
        // Saved Secret/Machine admission supplies the person facts (P3 manual target ruling).
        return { person: { mayWrite: true, editingOff: false }, agentAccess: record.agentAccess, requester };
    }
    function describe(record: ManualRecord, requester: DatabaseRequesterKindV1): DatabaseDescriptorV1 {
        return {
            target: record.target, label: record.label, engine: record.engine, origin: { label: 'Saved Secret' }, capabilities: [...databaseEngineCapabilities(record.engine, options.databaseEngines)],
            access: summarizeDatabaseAccessV1(accessFacts(record, requester)),
            placement: { serverId: record.target.workspace.serverId, accountId, ...hostMachine },
        };
    }
    async function readRecord(target: DatabaseManualTargetV1, signal?: AbortSignal): Promise<ManualRecord> {
        const key = targetKey(target);
        const record = parseRecord(await daemonStorage.get(key, { signal }));
        if (!record || targetKey(record.target) !== key) return unavailable();
        return record;
    }
    async function admitRecord(target: DatabaseTargetV1, access: DatabaseOperationClassV1,
        requestedBy: DatabaseRequesterKindV1 | undefined, signal?: AbortSignal) {
        const requester = requireRequester(requestedBy);
        if (target.kind !== 'manual') return unavailable();
        admitScope(targetScope(target));
        const record = await readRecord(target, signal);
        const facts = accessFacts(record, requester);
        const decision = decideDatabaseAccessV1({ ...facts, operation: access });
        if (!decision.ok) throw new PluginError({ code: decision.refusal });
        return { record, requester, summary: summarizeDatabaseAccessV1(facts) };
    }
    return {
        async list({ input, requester: requestedBy, signal }) {
            const requester = requireRequester(requestedBy);
            const scope = input.scope.kind === 'project' ? input.scope : admitScope(input.scope);
            if (scope.kind === 'project') admitHostScope(scope);
            const prefix = scope.kind === 'project' ? manualTargetsPrefix : scopePrefix(scope);
            const targets: DatabaseDescriptorV1[] = [];
            let cursor: string | undefined;
            do {
                const page = await daemonStorage.list({ prefix, cursor, signal });
                for (const item of page.items) {
                    const record = parseRecord(await daemonStorage.get(item.key, { signal }));
                    if (record && targetKey(record.target) === item.key && (scope.kind === 'project'
                        ? record.target.accountId === scope.accountId && record.target.installationId === scope.installationId && record.target.projectKey === scope.projectKey
                        : scopePrefix(targetScope(record.target)) === prefix)) {
                        targets.push(describe(record, requester));
                    }
                }
                cursor = page.nextCursor;
            } while (cursor);
            return { targets, completeness: { complete: true } };
        },
        async admit({ target, access, requester, signal }) {
            const { record, summary } = await admitRecord(target, access, requester, signal);
            return { agentAccess: record.agentAccess, access: summary };
        },
        async setAccess({ target, agentAccess, signal }) {
            admitScope(targetScope(target));
            const record = await readRecord(target, signal);
            if (record.agentAccess !== agentAccess) await daemonStorage.set(targetKey(target), { ...record, agentAccess }, { signal });
            return agentAccess;
        },
        async resolve({ input, access, requester: requestedBy, secrets, signal }) {
            const { record, requester } = await admitRecord(input.target, access, requestedBy, signal);
            if (record.target.kind !== 'manual') return unavailable();
            const target = record.target;
            const secretValue = await secrets.readSavedSecret(target.savedSecretId, { signal });
            const { openManualDatabaseConnection } = await import('./connection.js');
            const connection = await openManualDatabaseConnection({ target, secretValue, access, signal, databaseEngines: options.databaseEngines });
            return { descriptor: describe({ ...record, engine: connection.engine }, requester), connection };
        },
        async connect({ scope: requestedScope, savedSecretId, label, agentAccess, secrets, signal }) {
            const scope = admitScope(requestedScope);
            const target: DatabaseManualTargetV1 = { kind: 'manual', accountId: scope.accountId, workspace: scope.workspace, installationId: scope.installationId, projectKey: scope.projectKey, savedSecretId };
            const secretValue = await secrets.readSavedSecret(savedSecretId, { signal });
            const { openManualDatabaseConnection } = await import('./connection.js');
            const connection = await openManualDatabaseConnection({ target, secretValue, access: 'read', signal, databaseEngines: options.databaseEngines });
            try {
                const record: ManualRecord = { target, label, engine: connection.engine, agentAccess };
                await daemonStorage.set(targetKey(target), record, { signal });
                return describe(record, 'person');
            } finally { await connection.close(); }
        },
        async forget({ target, signal }) {
            admitScope(targetScope(target));
            await daemonStorage.delete(targetKey(target), { signal });
        },
    };
}
