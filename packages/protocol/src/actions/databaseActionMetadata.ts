import * as database from './actionIdsDatabaseV1.js';
import type { PluginActionContributionV2 } from '../plugins/actions/v2.js';
import { pluginActionDeclarationIsReadOnlyForInput } from '../plugins/actions/readOnly.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '../account/settings/savedSecretReferenceV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import * as z from '../zodRuntimePolicy.js';

const databaseReadAccessCreateApprovalFailureDetailsSchema = createStoredReadSchema(z.strictObject({
    savedSecretRef: SharedSavedSecretReferenceSelectionV1Schema.shape.ref,
    resourceRevision: SharedSavedSecretReferenceSelectionV1Schema.shape.resourceRevision,
}));

/** The approved Create may recover only the login selection after Save succeeds. */
export function projectDatabaseReadAccessCreateApprovalRecoveryV1(
    qualifiedActionId: string, errorCode: string | undefined, details: unknown,
) {
    if (qualifiedActionId !== database.DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1
        || errorCode !== 'database_read_role_binding_failed') return undefined;
    // The host can carry the author's details inside the projected PluginError.
    const payload = details && typeof details === 'object' && !('savedSecretRef' in details) && 'details' in details
        ? details.details : details;
    const parsed = databaseReadAccessCreateApprovalFailureDetailsSchema.safeParse(payload);
    return parsed.success ? { details: parsed.data } : {};
}

type Metadata = Pick<PluginActionContributionV2,
    'title' | 'description' | 'dangerLevel' | 'readOnly' | 'placementBindings' | 'confirmation' | 'confirmationWhen'
    | 'approvalScope' | 'approvalInputCustody' | 'secretInputPaths' | 'operation'> & Readonly<{
        /** Owner-local operand metadata; the plugin declaration projection strips it. */
        automationSubject?: Readonly<{ kind: 'database'; field: 'target' }>;
        /** Database privilege for a local preference mutation. */
        databaseAccess?: 'read';
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
    [database.DATABASE_TARGETS_LIST_ACTION_ID_V1]: { ...read, title: 'List databases',
        description: 'List the database destinations visible from the selected worktree or Deployment Environment.' },
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
        confirmation: { title: 'Apply these database changes?', mountedReview: 'exact_input' },
        secretInputPaths: ['changes.[].key.[].value.value', 'changes.[].original.[].value.value', 'changes.[].values.[].value.cell.value'],
    },
    [database.DATABASE_ACCESS_READ_ACTION_ID_V1]: { ...read, title: 'Read database access' },
    [database.DATABASE_ACCESS_SET_ACTION_ID_V1]: {
        ...targetWrite, dangerLevel: 'writesLocal', title: 'Set database access', placementBindings: ['secondary'],
        confirmation: { title: 'Change access to this database?', mountedReview: 'exact_input' },
    },
    [database.DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1]: {
        ...write, title: 'Attach read-only database login', approvalScope: 'environment',
        confirmation: { title: 'Use this read-only login?', mountedReview: 'exact_input' },
    },
    [database.DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1]: {
        ...write, title: 'Create read-only database login', approvalScope: 'environment',
        readOnly: { op: 'eq', path: 'mode', value: 'preview' },
        confirmationWhen: { op: 'eq', path: 'mode', value: 'apply' },
        confirmation: { title: 'Create this read-only login?', mountedReview: 'exact_input',
            inputFields: [{ path: 'statements', title: 'SQL statements' }] },
    },
    [database.UI_DATABASE_OPEN_ACTION_ID_V1]: { ...read, title: 'Open database', placementBindings: ['commandPalette', 'secondary'] },
    [database.UI_DATABASE_NAVIGATE_ACTION_ID_V1]: { ...read, title: 'Navigate database', placementBindings: ['toolbar', 'contextMenu'] },
    [database.UI_DATABASE_DRAFT_READ_ACTION_ID_V1]: { ...read, title: 'Read database draft' },
    [database.UI_DATABASE_HISTORY_CLEAR_ACTION_ID_V1]: {
        title: 'Clear database history',
        description: 'Clear SQL history for the addressed Workbench on the answering device and keep the current draft.',
        dangerLevel: 'writesLocal',
        readOnly: false,
        placementBindings: [],
        approvalInputCustody: 'live_only',
        confirmationWhen: { presentUserUi: true, cli: true },
        confirmation: {
            title: 'Clear database history?',
            body: 'Clear the SQL history for this database on the answering device. Keep the current SQL draft.',
            confirmLabel: 'Clear history',
        },
    },
    [database.DATABASE_STATS_READ_ACTION_ID_V1]: { ...read, title: 'Read database statistics' },
    [database.DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1]: {
        ...targetWrite, title: 'Cancel database activity', placementBindings: ['rowAction'], approvalScope: 'environment',
        confirmation: { title: 'Cancel this database session activity?', mountedReview: 'exact_input',
            inputFields: [{ path: 'activityKey', title: 'Backend PID' }, { path: 'queryStartedAt', title: 'Query started at' }] },
    },
    [database.DATABASE_STATS_ENABLE_ACTION_ID_V1]: {
        ...targetWrite, title: 'Enable database statistics', placementBindings: ['secondary'], approvalScope: 'environment',
        confirmation: { title: 'Enable statistics for this database?', mountedReview: 'exact_input',
            body: 'Runs CREATE EXTENSION IF NOT EXISTS pg_stat_statements on this database if PostgreSQL already has the library loaded.' },
    },
    [database.DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1]: { ...read, title: 'List database findings' },
    [database.DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1]: { ...read, title: 'Read database finding' },
    [database.DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1]: { ...read, title: 'Read selected database insight source' },
    [database.DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1]: {
        ...read, readOnly: false, dangerLevel: 'writesLocal', databaseAccess: 'read', title: 'Dismiss database finding',
        confirmationWhen: { presentUserUi: false },
        confirmation: { title: 'Dismiss this database finding?' },
    },
    [database.DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1]: { ...read, title: 'Prepare database brief' },
    [database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1]: { ...read, title: 'Read database capture status',
        description: 'Read the configured capabilities and retained capture coverage for the selected Environment or worktree.' },
    [database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1]: { ...read, title: 'List captured queries',
        description: 'Page through captured database query summaries within the requested source and time range.' },
    [database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1]: { ...read, title: 'Read captured query',
        description: 'Read the retained detail for one captured query or log record in the selected source.' },
    [database.DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1]: { ...read, title: 'List captured traces',
        description: 'Page through captured trace summaries within the requested source and time range.' },
    [database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1]: { ...read, title: 'Read captured trace',
        description: 'Read spans and capture details for one trace in the selected source.' },
    [database.DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1]: { ...read, title: 'List captured logs',
        description: 'Page through retained log summaries within the requested source and time range.' },
    [database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1]: { ...read, title: 'List captured endpoints',
        description: 'Read aggregated endpoint activity within the requested source and time range, or inspect one named endpoint.' },
    [database.DATABASE_CAPTURE_CLEAR_ACTION_ID_V1]: {
        description: 'Delete the retained telemetry in the selected Environment or worktree capture partition.',
        ...write, dangerLevel: 'destructive', title: 'Clear capture', placementBindings: ['contextMenu'], approvalScope: 'environment',
        // One wording for the act everywhere it is offered (menu "Clear capture…"); the body says its consequence once.
        confirmation: {
            title: 'Clear capture?',
            body: 'Removes recorded requests, traces and logs for this checkout. Capture stays on.',
            confirmLabel: 'Clear capture',
        },
    },
    [database.DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1]: {
        description: 'Change whether the selected worktree captures telemetry on its Machine.',
        ...write, dangerLevel: 'writesLocal', title: 'Change capture', placementBindings: ['secondary'],
        // Turning capture on (and retrying it) asks once, in the menu's words ("Turn on capture"); turning it off is
        // the person taking back what they turned on and asks nothing (DBW services item 8).
        confirmationWhen: { op: 'eq', path: 'enabled', value: true },
        confirmation: {
            title: 'Turn on capture?',
            body: 'Records each request’s route, time, database queries and logs on this Machine. Restarts this checkout’s dev servers once.',
            confirmLabel: 'Turn on capture',
        },
    },
    [database.TELEMETRY_METRICS_READ_ACTION_ID_V1]: { ...read, title: 'Read selected telemetry metrics',
        description: 'Read a service’s selected measure and capture coverage over the requested Environment and time window.' },
    [database.TELEMETRY_COSTS_READ_ACTION_ID_V1]: { ...read, title: 'Read selected app LLM cost operands' },
    [database.TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1]: { ...read, title: 'Check saved key flow',
        description: 'Evaluate the threshold of one saved key-flow check against its collector’s retained samples.' },
    [database.TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1]: { ...read, title: 'Compare retained deployment windows' },
    [database.TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1]: { ...read, title: 'Read regression check time' },
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
        const { automationSubject: _automationSubject, databaseAccess: _databaseAccess, ...metadata } = declaration;
        return [id, metadata];
    })) as { [K in keyof T]: Omit<T[K], 'automationSubject' | 'databaseAccess'> };
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
    const declaration = databaseActionDeclarations[actionId];
    if ('databaseAccess' in declaration) return declaration.databaseAccess;
    return pluginActionDeclarationIsReadOnlyForInput(databaseActionMetadata[actionId], input) ? 'read' : 'write';
}
