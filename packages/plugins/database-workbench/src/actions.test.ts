import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
    DATABASE_EDITS_APPLY_ACTION_ID_V1,
    DATABASE_ROWS_READ_ACTION_ID_V1,
    DATABASE_ROWS_EXPORT_ACTION_ID_V1,
    DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1,
    DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
    DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
    DATABASE_TARGETS_FORGET_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
    DATABASE_DESCRIBE_ACTION_ID_V1,
    DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import {
    type DatabaseDescriptorV1,
    type DatabaseFindingsListInputV1,
    type DatabaseFindingsListResultV1,
    type DatabaseFindingReadInputV1,
    type DatabaseFindingReadResultV1,
    type DatabaseInsightBriefBuildInputV1,
    type DatabaseFindingBriefBuildResultV1,
    DatabaseEditsApplyInputV1Schema,
    DatabaseRowsReadInputV1Schema,
    DatabaseStatementRunInputV1Schema,
} from '@happier-dev/plugin-sdk/database';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { pluginActionDeclarationIsReadOnlyForInput, pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol/plugins/actions/invocation';
import { projectTargetActionApprovalInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { PluginActionContributionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { createDatabaseActions } from './actions.js';
import { databaseActionOperationClass } from '@happier-dev/plugin-sdk/actions';
import { buildDatabaseFindingBriefV1 } from './insights/brief.js';

const target = {
    kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' },
    source: { kind: 'service', serviceId: 'api', variable: 'DATABASE_URL' },
} as const;

function declarations() {
    const actions = definePlugin({
        id: 'happier.database', version: '0.0.0', displayName: 'Database',
        actions: createDatabaseActions({
            executeOperation: () => ({ ok: false, status: 'unavailable', code: 'database_unavailable', reason: 'No connection in a declaration test' }),
        }),
    }).manifest.contributes.actions ?? [];
    return actions.map(action => PluginActionContributionV2Schema.parse(action));
}

describe('producer-backed database Action declarations', () => {
    it('invokes findings and real task briefs through their canonical schemas without agent exposure', async () => {
        const unavailable = { ok: false, status: 'unavailable', code: 'database_unavailable', reason: 'The fixture database is offline' } as const;
        const producers = {
            executeOperation: () => unavailable,
            listFindings: (_input: DatabaseFindingsListInputV1): DatabaseFindingsListResultV1 => unavailable,
            readFinding: (_input: DatabaseFindingReadInputV1): DatabaseFindingReadResultV1 => unavailable,
            buildInsightBrief: (input: DatabaseInsightBriefBuildInputV1): DatabaseFindingBriefBuildResultV1 => 'task' in input
                ? { ok: true, brief: buildDatabaseFindingBriefV1(input.task) } : unavailable,
        };
        const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions(producers) });
        const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            const listInput = { target, request: { kind: 'stats.read', group: 'statements', selection: { page: { rows: 5 }, order: 'calls' } } };
            await expect(testkit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1), listInput))
                .resolves.toEqual(unavailable);
            await expect(testkit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1),
                { ...listInput, recordKey: 'statement' })).resolves.toEqual(unavailable);
            const task = { kind: 'setup', target, sourceScope: { serverId: 'home', machineId: 'machine' } };
            await expect(testkit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1), { task }))
                .resolves.toMatchObject({ ok: true, brief: { text: expect.stringContaining('Review the required database statistics setup') } });
            await expect(testkit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1),
                { task: { ...task, sql: 'private SQL is not setup evidence' } })).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
            const declarations = plugin.manifest.contributes.actions ?? [];
            expect(declarations.filter(action => [DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
                DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1, DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1]
                .some(id => action.id === databaseActionLocalIdV1(id)))
                .every(action => action.surfaces.includes('agent') && action.surfaces.includes('plugin'))).toBe(true);
        } finally {
            await testkit.dispose();
        }
    });

    it('keeps the canonical capture identity equal to its real owning occurrence invocation', async () => {
        const localId = databaseActionLocalIdV1(DATABASE_CAPTURE_STATUS_ACTION_ID_V1);
        const plugin = definePlugin({ id: 'happier.telemetry', version: '0.0.0',
            actions: { [localId]: { title: 'Capture identity fixture', surfaces: ['plugin'], readOnly: true,
                run: (_input, context) => context.contribution.qualifiedId } },
        });
        const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            await expect(testkit.invokeAction(localId, {})).resolves.toBe(DATABASE_CAPTURE_STATUS_ACTION_ID_V1);
        } finally {
            await testkit.dispose();
        }
    });

    it.each([
        { kind: 'worktree', binding: target, subjectTarget: target },
        { kind: 'manual', binding: { kind: 'manual', accountId: target.accountId, installationId: target.installationId,
            projectKey: target.projectKey, workspace: target.workspace, savedSecretId: 'saved-connection' },
            subjectTarget: { kind: 'manual', accountId: target.accountId, installationId: target.installationId,
                projectKey: target.projectKey, workspace: target.workspace, savedSecretId: 'saved-connection' } },
        { kind: 'deployment_service', binding: { kind: 'deployment_service',
            environment: { serverId: 'home', projectSourceId: 'app', environmentId: 'environment' },
            targetLinkId: 'runtime', deploymentId: 'serving', serviceId: 'postgres', database: 'app' },
            subjectTarget: { kind: 'environment', environmentId: 'environment', service: 'postgres', database: 'app' } },
    ] as const)('transports $kind producer results with canonical subjects through real Action admission', async ({ binding, subjectTarget }) => {
        const descriptor = { target: binding, label: 'Database', engine: 'postgresql',
            origin: { label: 'Service', environment: undefined }, capabilities: [], access: undefined,
            placement: { serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'installation' },
        } satisfies DatabaseDescriptorV1;
        const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', displayName: 'Database',
            actions: createDatabaseActions({
                listTargets: async () => ({ targets: [descriptor], completeness: { complete: true } }),
                connectTarget: () => descriptor,
                executeOperation: async () => ({ ok: true, operation: 'describe', descriptor }),
            }),
        });
        const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            const expectedDescriptor = { target: binding, label: 'Database', engine: 'postgresql', origin: { label: 'Service' },
                capabilities: [], placement: descriptor.placement,
                automationSubject: { ok: true, subject: { kind: 'database', serverId: 'home', target: subjectTarget } } };
            const scope = { kind: 'worktree', accountId: target.accountId, installationId: target.installationId,
                projectKey: target.projectKey, workspace: target.workspace };
            const list = await testkit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1), { scope });
            expect(list).toEqual({ targets: [expectedDescriptor], completeness: { complete: true } });
            expect(list).not.toHaveProperty('targets.0.origin.environment');
            expect(list).not.toHaveProperty('targets.0.access');
            const connect = await testkit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_CONNECT_ACTION_ID_V1),
                { scope, savedSecretRef: 'saved-secret', label: 'Database' });
            expect(connect).toEqual(expectedDescriptor);
            expect(connect).not.toHaveProperty('origin.environment');
            expect(connect).not.toHaveProperty('access');
            const describe = await testkit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1),
                { operation: 'describe', target });
            expect(describe).toEqual({ ok: true, operation: 'describe', descriptor: expectedDescriptor });
            expect(describe).not.toHaveProperty('descriptor.origin.environment');
            expect(describe).not.toHaveProperty('descriptor.access');
        } finally {
            await testkit.dispose();
        }
    });

    it('declares Connect and Forget from their producers with confirmation for agent calls', () => {
        const producers = {
            connectTarget: async () => { throw new Error('Declaration test does not acquire a connection'); },
            forgetTarget: async () => {},
        };
        const actions = definePlugin({ id: 'happier.database', version: '0.0.0', displayName: 'Database',
            actions: createDatabaseActions(producers),
        }).manifest.contributes.actions?.map(action => PluginActionContributionV2Schema.parse(action)) ?? [];
        const connect = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_TARGETS_CONNECT_ACTION_ID_V1));
        const forget = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1));
        expect(connect).toMatchObject({ dangerLevel: 'writesLocal', readOnly: false, surfaces: ['ui', 'cli', 'plugin', 'agent'] });
        expect(forget).toMatchObject({ dangerLevel: 'writesLocal', readOnly: false, surfaces: ['ui', 'cli', 'plugin', 'agent'] });
        expect(forget?.confirmation).toBeDefined();
        expect(connect?.secretInputPaths ?? []).toEqual([]);
        expect(forget?.secretInputPaths ?? []).toEqual([]);
        expect(pluginActionRequiresPresentUserIntent(connect!, 'agent')).toBe(true);
        expect(pluginActionRequiresPresentUserIntent(forget!, 'agent')).toBe(true);
    });

    it('exposes admitted read operations while retaining canonical write classification', () => {
        const actions = declarations();
        const run = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1))!;
        const explain = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1))!;
        const rows = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1))!;
        expect(pluginActionDeclarationIsReadOnlyForInput(run, { mode: 'read' })).toBe(true);
        expect(pluginActionDeclarationIsReadOnlyForInput(run, { mode: 'write' })).toBe(false);
        expect(pluginActionDeclarationIsReadOnlyForInput(explain, { accessMode: 'read', mode: 'analyze' })).toBe(true);
        expect(pluginActionDeclarationIsReadOnlyForInput(explain, { accessMode: 'write', mode: 'plan' })).toBe(true);
        expect(pluginActionDeclarationIsReadOnlyForInput(explain, { accessMode: 'write', mode: 'analyze' })).toBe(false);
        expect(databaseActionOperationClass(DATABASE_STATEMENT_RUN_ACTION_ID_V1, { mode: 'read' })).toBe('read');
        expect(databaseActionOperationClass(DATABASE_STATEMENT_RUN_ACTION_ID_V1, { mode: 'write' })).toBe('write');
        expect(databaseActionOperationClass(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1, { mode: 'analyze', accessMode: 'read' })).toBe('read');
        expect(rows.placementBindings).toEqual([]);
        expect(rows.surfaces).toEqual(['ui', 'cli', 'plugin', 'agent', 'mcp']);
        expect(run.surfaces).toEqual(rows.surfaces);
        expect(explain.surfaces).toEqual(rows.surfaces);
        const edits = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_EDITS_APPLY_ACTION_ID_V1))!;
        // D13: agents reach writes; the access decider and the Environment level decide admission and Ask.
        expect(edits.surfaces).toEqual(rows.surfaces);
        expect(pluginActionRequiresPresentUserIntent(run, 'agent', { mode: 'read' })).toBe(false);
        expect(pluginActionRequiresPresentUserIntent(run, 'agent', { mode: 'write' })).toBe(true);
    });

    it('keeps SQL and mutation metadata visible while redacting only nested values', () => {
        const actions = declarations();
        const run = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1))!;
        const edits = actions.find(action => action.id === databaseActionLocalIdV1(DATABASE_EDITS_APPLY_ACTION_ID_V1))!;
        const statement = DatabaseStatementRunInputV1Schema.parse({ operation: 'statement.run', target,
            mode: 'write', executionMode: 'transaction',
            statements: [{ sql: 'UPDATE users SET name = $1', parameters: [{ type: 'text', value: 'private' }] }],
        });
        expect(projectTargetActionApprovalInput(statement, run.secretInputPaths)?.input).toEqual({
            ...statement, statements: [{ sql: 'UPDATE users SET name = $1', parameters: [{ type: 'text', value: '[REDACTED]' }] }],
        });
        const changes = DatabaseEditsApplyInputV1Schema.parse({ operation: 'edits.apply', target,
            relation: { schema: 'public', name: 'users' }, changes: [{ kind: 'update',
            key: [{ column: 'id', value: { type: 'text', value: 'private-key' } }],
            original: [{ column: 'name', value: { type: 'text', value: 'private-old' } }],
            values: [{ column: 'name', value: { kind: 'value', cell: { type: 'text', value: 'private-new' } } }],
        }, { kind: 'insert', values: [{ column: 'id', value: { kind: 'default' } }] }] });
        expect(projectTargetActionApprovalInput(changes, edits.secretInputPaths)?.input).toEqual({
            ...changes, changes: [{ kind: 'update', key: [{ column: 'id', value: { type: 'text', value: '[REDACTED]' } }],
                original: [{ column: 'name', value: { type: 'text', value: '[REDACTED]' } }],
                values: [{ column: 'name', value: { kind: 'value', cell: { type: 'text', value: '[REDACTED]' } } }] },
            { kind: 'insert', values: [{ column: 'id', value: { kind: 'default' } }] }],
        });
        expect(run.approvalInputCustody).toBe('live_only');
        expect(edits.approvalInputCustody).toBe('live_only');
    });

    it('redacts real recursive row filters and keyset operands without hiding filter or cell metadata', () => {
        const rows = declarations().find(action => action.id === databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1))!;
        const filter = { kind: 'not', filter: { kind: 'and', filters: [
            { kind: 'comparison', column: 'name', operator: 'eq', value: { type: 'text', value: 'private-filter' } },
            { kind: 'null', column: 'deleted', isNull: true },
        ] } };
        const relation = { schema: 'public', name: 'users' };
        const input = { operation: 'rows.read', target, relation, columns: ['id', 'name'], filter, order: [],
            page: { rows: 25, continuation: { kind: 'keyset', direction: 'forward',
                binding: { target, relation, columns: ['id', 'name'], filter, order: [] },
                values: [{ column: 'id', value: { type: 'integer', value: '987654321' } }],
            } },
        };
        const redactedFilter = { kind: 'not', filter: { kind: 'and', filters: [
            { kind: 'comparison', column: 'name', operator: 'eq', value: { type: 'text', value: '[REDACTED]' } },
            { kind: 'null', column: 'deleted', isNull: true },
        ] } };
        expect(projectTargetActionApprovalInput(DatabaseRowsReadInputV1Schema.parse(input), rows.secretInputPaths)?.input).toEqual({
            ...input, filter: redactedFilter, page: { ...input.page, continuation: { ...input.page.continuation,
                binding: { ...input.page.continuation.binding, filter: redactedFilter },
                values: [{ column: 'id', value: { type: 'integer', value: '[REDACTED]' } }],
            } },
        });
    });

    it('declares no database operation without its producer, retaining the loaded-result serializer', () => {
        expect(Object.keys(createDatabaseActions({}))).toEqual([
            databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_ACTION_ID_V1), databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1),
        ]);
    });
});
