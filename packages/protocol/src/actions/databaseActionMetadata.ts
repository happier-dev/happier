import * as database from './actionIdsDatabaseV1.js';
import type { PluginActionContributionV2 } from '../plugins/actions/v2.js';
import { pluginActionDeclarationIsReadOnlyForInput } from '../plugins/actions/readOnly.js';

type Metadata = Pick<PluginActionContributionV2,
    'title' | 'dangerLevel' | 'readOnly' | 'placementBindings' | 'confirmation' | 'confirmationWhen'
    | 'approvalScope' | 'approvalInputCustody' | 'secretInputPaths' | 'operation'> & Readonly<{
        /** Owner-local operand metadata; the plugin declaration projection strips it. */
        automationSubject?: Readonly<{ kind: 'database'; field: 'target' }>;
    }>;

const read = { dangerLevel: 'safe', readOnly: true, placementBindings: [] } satisfies Omit<Metadata, 'title'>;
const write = { dangerLevel: 'writesRemote', readOnly: false } as const;
const databaseOperation = { version: 1, visibility: 'activity', progress: 'indeterminate',
    cancellation: 'supported', presentation: { onStart: 'activity' } } as const;
const targetWrite = { ...write, automationSubject: { kind: 'database', field: 'target' } } as const;
const selectedExport = { ...read, approvalInputCustody: 'live_only',
    secretInputPaths: ['result.rows.[].cells.[].value', 'result.rows.[].identity.**.value.value', 'result.completeness.continuation.**.value.value'],
} satisfies Omit<Metadata, 'title'>;

/** C6's one presentation/classification owner. Missing producers contribute no callable Action. */
const databaseActionDeclarations = {
    [database.DATABASE_TARGETS_LIST_ACTION_ID_V1]: { ...read, title: 'List databases' },
    [database.DATABASE_TARGETS_CONNECT_ACTION_ID_V1]: {
        ...write, dangerLevel: 'writesLocal', title: 'Connect database', placementBindings: ['primary'],
        confirmation: { title: 'Connect this database?' },
    },
    [database.DATABASE_TARGETS_FORGET_ACTION_ID_V1]: {
        ...targetWrite, dangerLevel: 'writesLocal', title: 'Forget database', placementBindings: ['contextMenu'],
        confirmation: { title: 'Forget this database?' },
    },
    [database.DATABASE_DESCRIBE_ACTION_ID_V1]: { ...read, title: 'Describe database' },
    [database.DATABASE_SCHEMAS_LIST_ACTION_ID_V1]: { ...read, title: 'List database schemas' },
    [database.DATABASE_RELATIONS_LIST_ACTION_ID_V1]: { ...read, title: 'List database relations' },
    [database.DATABASE_STRUCTURE_READ_ACTION_ID_V1]: { ...read, title: 'Read relation structure' },
    [database.DATABASE_ROWS_READ_ACTION_ID_V1]: {
        ...read, title: 'Read database rows', approvalInputCustody: 'live_only',
        secretInputPaths: ['filter.**.value.value', 'page.continuation.binding.filter.**.value.value', 'page.continuation.values.[].value.value'],
    },
    [database.DATABASE_ROWS_EXPORT_ACTION_ID_V1]: {
        ...selectedExport, title: 'Export selected database rows',
    },
    [database.DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1]: {
        ...selectedExport, title: 'Save selected database rows', dangerLevel: 'writesLocal', readOnly: false,
        operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
        confirmationWhen: { presentUserUi: false },
        confirmation: { title: 'Save these database rows?', body: 'Save the selected loaded rows to the receiving device’s chosen destination.', confirmLabel: 'Save' },
    },
    [database.DATABASE_CELL_READ_ACTION_ID_V1]: {
        ...read, title: 'Read database cell', approvalInputCustody: 'live_only', secretInputPaths: ['key.[].value.value'],
    },
    [database.DATABASE_STATEMENT_RUN_ACTION_ID_V1]: {
        ...targetWrite, title: 'Run SQL', placementBindings: ['toolbar'], approvalScope: 'environment',
        operation: databaseOperation,
        approvalInputCustody: 'live_only',
        readOnly: { op: 'eq', path: 'mode', value: 'read' },
        confirmationWhen: { op: 'eq', path: 'mode', value: 'write' },
        confirmation: { title: 'Run these database changes?' },
        secretInputPaths: ['statement.parameters.[].value', 'statements.[].parameters.[].value'],
    },
    [database.DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1]: {
        ...targetWrite, title: 'Explain SQL', placementBindings: ['toolbar'], approvalScope: 'environment',
        operation: databaseOperation,
        readOnly: { op: 'or', any: [
            { op: 'eq', path: 'mode', value: 'plan' },
            { op: 'eq', path: 'accessMode', value: 'read' },
        ] },
        confirmationWhen: { op: 'and', all: [
            { op: 'eq', path: 'mode', value: 'analyze' },
            { op: 'eq', path: 'accessMode', value: 'write' },
        ] },
        confirmation: { title: 'Analyze these database changes?' },
        approvalInputCustody: 'live_only', secretInputPaths: ['statement.parameters.[].value'],
    },
    [database.DATABASE_EDITS_APPLY_ACTION_ID_V1]: {
        ...targetWrite, title: 'Apply database changes', placementBindings: ['primary'], approvalScope: 'environment',
        operation: databaseOperation,
        approvalInputCustody: 'live_only',
        confirmation: { title: 'Apply these database changes?' },
        secretInputPaths: ['changes.[].key.[].value.value', 'changes.[].original.[].value.value', 'changes.[].values.[].value.cell.value'],
    },
    [database.DATABASE_ACCESS_READ_ACTION_ID_V1]: { ...read, title: 'Read database access' },
    [database.DATABASE_ACCESS_SET_ACTION_ID_V1]: {
        ...targetWrite, dangerLevel: 'writesLocal', title: 'Set database access', placementBindings: ['secondary'],
        confirmation: { title: 'Change access to this database?' },
    },
    [database.UI_DATABASE_OPEN_ACTION_ID_V1]: { ...read, title: 'Open database', placementBindings: ['commandPalette', 'secondary'] },
    [database.UI_DATABASE_NAVIGATE_ACTION_ID_V1]: { ...read, title: 'Navigate database', placementBindings: ['toolbar', 'contextMenu'] },
    [database.UI_DATABASE_DRAFT_READ_ACTION_ID_V1]: { ...read, title: 'Read database draft' },
    [database.DATABASE_STATS_READ_ACTION_ID_V1]: { ...read, title: 'Read database statistics' },
    [database.DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1]: {
        ...write, title: 'Cancel database activity', placementBindings: ['rowAction'],
        confirmation: { title: 'Cancel this database session activity?' },
    },
    [database.DATABASE_STATS_ENABLE_ACTION_ID_V1]: {
        ...write, title: 'Enable database statistics', placementBindings: ['secondary'], approvalScope: 'environment',
        confirmation: { title: 'Enable statistics for this database?' },
    },
    [database.DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1]: { ...read, title: 'List database findings' },
    [database.DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1]: { ...read, title: 'Read database finding' },
    [database.DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1]: { ...read, title: 'Prepare database brief' },
    [database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1]: { ...read, title: 'Read database capture status' },
    [database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1]: { ...read, title: 'List captured queries' },
    [database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1]: { ...read, title: 'Read captured query' },
    [database.DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1]: { ...read, title: 'List captured traces' },
    [database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1]: { ...read, title: 'Read captured trace' },
    [database.DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1]: { ...read, title: 'List captured logs' },
    [database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1]: { ...read, title: 'List captured endpoints' },
    [database.DATABASE_CAPTURE_CLEAR_ACTION_ID_V1]: {
        ...write, dangerLevel: 'destructive', title: 'Clear database capture', placementBindings: ['contextMenu'],
        confirmation: { title: 'Delete the captured database activity?' },
    },
    [database.DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1]: {
        ...write, dangerLevel: 'writesLocal', title: 'Configure database capture', placementBindings: ['secondary'],
        confirmation: { title: 'Change database capture for this project?' },
    },
    [database.TELEMETRY_METRICS_READ_ACTION_ID_V1]: { ...read, title: 'Read selected telemetry metrics' },
    [database.TELEMETRY_COSTS_READ_ACTION_ID_V1]: { ...read, title: 'Read selected app LLM cost operands' },
    [database.TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1]: { ...read, title: 'Check saved key flow' },
    [database.TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1]: { ...read, title: 'Compare retained deployment windows' },
    [database.TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1]: {
        ...write, title: 'Schedule regression check', placementBindings: [],
        confirmation: { title: 'Schedule this Workflow’s regression check?' },
    },
    [database.TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1]: { ...read, title: 'Read exception occurrences' },
    // Native issue lifecycle edits go to the collector's single issue writer.
    [database.TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1]: {
        ...write, title: 'Change an exception issue', placementBindings: ['secondary'],
        confirmation: { title: 'Change this issue’s status?' },
    },
    [database.TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1]: {
        ...write, title: 'Refresh exception issues', placementBindings: [],
        confirmation: { title: 'Refresh exception issues?' },
    },
} as const satisfies Record<database.DatabaseActionIdV1, Metadata>;

function projectPluginMetadata<T extends Record<string, Metadata>>(declarations: T) {
    return Object.fromEntries(Object.entries(declarations).map(([id, declaration]) => {
        const { automationSubject: _automationSubject, ...metadata } = declaration;
        return [id, metadata];
    })) as { [K in keyof T]: Omit<T[K], 'automationSubject'> };
}

/** The strict plugin declaration contains only its public authoring fields. */
export const databaseActionMetadata = projectPluginMetadata(databaseActionDeclarations);

/** Catalog and admitted invocation consume the same Database operand declaration. */
export function readDatabaseActionAutomationMetadataV1(actionId: string): Readonly<{
    subjectKinds: readonly ('environment' | 'database')[];
    primarySubject: Readonly<{ kind: 'database'; field: 'target' }>;
}> | undefined {
    if (!database.isDatabaseActionIdV1(actionId)) return undefined;
    const declaration = databaseActionDeclarations[actionId];
    if (!('automationSubject' in declaration)) return undefined;
    return { subjectKinds: 'approvalScope' in declaration && declaration.approvalScope === 'environment'
        ? ['environment', 'database'] : ['database'], primarySubject: declaration.automationSubject };
}

/** Admission and execution consume the declaration's canonical input predicate. */
export function databaseActionOperationClass(actionId: database.DatabaseActionIdV1, input: unknown): 'read' | 'write' {
    return pluginActionDeclarationIsReadOnlyForInput(databaseActionMetadata[actionId], input) ? 'read' : 'write';
}
