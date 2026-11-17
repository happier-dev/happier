import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import * as database from '@happier-dev/database-protocol';
import { databaseActionMetadata } from '@happier-dev/database-protocol';
import { exportSelectedRows } from './selectedExport.js';
import { FileDownloadResultV1ProtocolSchema, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';

export { databaseActionMetadata, databaseActionOperationClass } from '@happier-dev/database-protocol';

function projectDescriptor(descriptor: database.DatabaseDescriptorV1): database.DatabaseDescriptorV1 {
    return { ...descriptor, automationSubject: descriptor.automationSubject
        ?? database.readAutomationDatabaseSubjectV1(descriptor.placement.serverId, descriptor.target) };
}

export type DatabaseActionProducers = Readonly<{
    listTargets?: (input: database.DatabaseTargetsListInputV1, context: PluginInvocationContext)
        => database.DatabaseTargetsListResultV1 | Promise<database.DatabaseTargetsListResultV1>;
    connectTarget?: (input: database.DatabaseTargetsConnectInputV1, context: PluginInvocationContext)
        => database.DatabaseDescriptorV1 | Promise<database.DatabaseDescriptorV1>;
    forgetTarget?: (input: database.DatabaseTargetsForgetInputV1, context: PluginInvocationContext) => void | Promise<void>;
    executeOperation?: (input: database.DatabaseOperationInputV1, context: PluginInvocationContext)
        => database.DatabaseOperationResultV1 | Promise<database.DatabaseOperationResultV1>;
    listFindings?: (input: database.DatabaseFindingsListInputV1, context: PluginInvocationContext)
        => database.DatabaseFindingsListResultV1 | Promise<database.DatabaseFindingsListResultV1>;
    readFinding?: (input: database.DatabaseFindingReadInputV1, context: PluginInvocationContext)
        => database.DatabaseFindingReadResultV1 | Promise<database.DatabaseFindingReadResultV1>;
    buildInsightBrief?: (input: database.DatabaseInsightBriefBuildInputV1, context: PluginInvocationContext)
        => database.DatabaseFindingBriefBuildResultV1 | Promise<database.DatabaseFindingBriefBuildResultV1>;
    readAccess?: (input: database.DatabaseAccessReadInputV1, context: PluginInvocationContext)
        => database.DatabaseAccessReadResultV1 | Promise<database.DatabaseAccessReadResultV1>;
    setAccess?: (input: database.DatabaseAccessSetInputV1, context: PluginInvocationContext)
        => database.DatabaseAccessSetResultV1 | Promise<database.DatabaseAccessSetResultV1>;
}>;

/** The existing plugin producer supplies handlers; the SDK owns input/result admission. */
export function createDatabaseActions(producers: DatabaseActionProducers): Record<string, PluginActionDefinition> {
    const actions: Record<string, PluginActionDefinition> = {};
    const common = { execution: { target: 'daemon' }, scopes: ['global'], surfaces: ['ui', 'cli', 'plugin'] } as const;
    const readSurfaces = ['ui', 'cli', 'plugin', 'agent', 'mcp'] as const;
    const { agentDefault: _exportAgentDefault, ...exportMetadata } = databaseActionMetadata[database.DATABASE_ROWS_EXPORT_ACTION_ID_V1];
    actions[database.databaseActionLocalIdV1(database.DATABASE_ROWS_EXPORT_ACTION_ID_V1)] = {
        ...common, ...exportMetadata, surfaces: readSurfaces,
        inputSchema: database.DatabaseSelectedRowsExportInputV1ProtocolSchema,
        resultSchema: database.DatabaseSelectedRowsExportResultV1ProtocolSchema,
        // The SDK admits the supplied selected-result shape; serialization performs no database read.
        run: (input: JsonValue) => projectNativeJsonValueForTransport(exportSelectedRows(input as database.DatabaseSelectedRowsExportInputV1)),
    };
    const { agentDefault: _downloadAgentDefault, ...downloadMetadata } = databaseActionMetadata[database.DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1];
    actions[databaseActionLocalIdV1(database.DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1)] = {
        ...common, ...downloadMetadata,
        inputSchema: database.DatabaseSelectedRowsExportDownloadInputV1ProtocolSchema,
        resultSchema: FileDownloadResultV1ProtocolSchema,
        run: async (input: JsonValue, context: PluginInvocationContext) => {
            const selected = input as database.DatabaseSelectedRowsExportDownloadInputV1;
            const exported = exportSelectedRows(selected);
            return projectNativeJsonValueForTransport(await context.services.fs.prepareDownload({
                name: `database-rows.${exported.format}`, bytes: new TextEncoder().encode(exported.content), destination: selected.destination,
            }, { signal: context.signal }));
        },
    };
    const listTargets = producers.listTargets;
    if (listTargets) {
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[database.DATABASE_TARGETS_LIST_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_TARGETS_LIST_ACTION_ID_V1)] = {
            ...common, ...metadata, surfaces: readSurfaces,
            inputSchema: database.DatabaseTargetsListInputV1ProtocolSchema,
            resultSchema: database.DatabaseTargetsListResultV1ProtocolSchema,
            // definePlugin supplies the value admitted by this exact input schema.
            run: async (input: JsonValue, context: PluginInvocationContext) => {
                const result = await listTargets(input as database.DatabaseTargetsListInputV1, context);
                return projectNativeJsonValueForTransport({ ...result, targets: result.targets.map(projectDescriptor) });
            },
        };
    }
    const connectTarget = producers.connectTarget;
    if (connectTarget) {
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[database.DATABASE_TARGETS_CONNECT_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_TARGETS_CONNECT_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseTargetsConnectInputV1ProtocolSchema,
            resultSchema: database.DatabaseTargetsConnectResultV1ProtocolSchema,
            // The SDK admits the canonical association input before acquiring a connection.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                projectDescriptor(await connectTarget(input as database.DatabaseTargetsConnectInputV1, context))),
        };
    }
    const forgetTarget = producers.forgetTarget;
    if (forgetTarget) {
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[database.DATABASE_TARGETS_FORGET_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_TARGETS_FORGET_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseTargetsForgetInputV1ProtocolSchema,
            resultSchema: database.DatabaseTargetsForgetResultV1ProtocolSchema,
            // The existing producer removes the association and retains the Saved Secret.
            run: async (input: JsonValue, context: PluginInvocationContext) => {
                await forgetTarget(input as ReturnType<typeof database.DatabaseTargetsForgetInputV1ProtocolSchema.parse>, context);
                return { ok: true };
            },
        };
    }
    const executeOperation = producers.executeOperation;
    if (executeOperation) for (const [qualifiedId, inputSchema] of Object.entries(database.DATABASE_OPERATION_ACTION_INPUT_SCHEMAS_V1)) {
        const actionId = qualifiedId as keyof typeof database.DATABASE_OPERATION_ACTION_INPUT_SCHEMAS_V1;
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[actionId];
        actions[database.databaseActionLocalIdV1(actionId)] = {
            ...common, ...metadata, inputSchema,
            // Agents reach writes too: the access decider and the D13 level decide admission and Ask.
            surfaces: readSurfaces,
            resultSchema: database.DatabaseOperationResultV1ProtocolSchema,
            // All entries come from the P1 operation union; the SDK has already parsed the input.
            run: async (input: JsonValue, context: PluginInvocationContext) => {
                const result = await executeOperation(input as database.DatabaseOperationInputV1, context);
                return projectNativeJsonValueForTransport(result.ok && result.operation === 'describe'
                    ? { ...result, descriptor: projectDescriptor(result.descriptor) } : result);
            },
        };
    }
    const listFindings = producers.listFindings;
    if (listFindings) {
        const actionId = database.DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1;
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[actionId];
        actions[database.databaseActionLocalIdV1(actionId)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseFindingsListInputV1ProtocolSchema,
            resultSchema: database.DatabaseFindingsListResultV1ProtocolSchema,
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await listFindings(input as database.DatabaseFindingsListInputV1, context)),
        };
    }
    const readFinding = producers.readFinding;
    if (readFinding) {
        const actionId = database.DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1;
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[actionId];
        actions[database.databaseActionLocalIdV1(actionId)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseFindingReadInputV1ProtocolSchema,
            resultSchema: database.DatabaseFindingReadResultV1ProtocolSchema,
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await readFinding(input as database.DatabaseFindingReadInputV1, context)),
        };
    }
    const buildInsightBrief = producers.buildInsightBrief;
    if (buildInsightBrief) {
        const actionId = database.DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1;
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[actionId];
        actions[database.databaseActionLocalIdV1(actionId)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseInsightBriefBuildInputV1ProtocolSchema,
            resultSchema: database.DatabaseFindingBriefBuildResultV1ProtocolSchema,
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await buildInsightBrief(input as database.DatabaseInsightBriefBuildInputV1, context)),
        };
    }
    const readAccess = producers.readAccess;
    if (readAccess) {
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[database.DATABASE_ACCESS_READ_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_ACCESS_READ_ACTION_ID_V1)] = {
            ...common, ...metadata, surfaces: readSurfaces,
            inputSchema: database.DatabaseAccessReadInputV1ProtocolSchema,
            resultSchema: database.DatabaseAccessReadResultV1ProtocolSchema,
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await readAccess(input as database.DatabaseAccessReadInputV1, context)),
        };
    }
    const setAccess = producers.setAccess;
    if (setAccess) {
        const { agentDefault: _agentDefault, ...metadata } = databaseActionMetadata[database.DATABASE_ACCESS_SET_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_ACCESS_SET_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseAccessSetInputV1ProtocolSchema,
            resultSchema: database.DatabaseAccessSetResultV1ProtocolSchema,
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await setAccess(input as database.DatabaseAccessSetInputV1, context)),
        };
    }
    return actions;
}
