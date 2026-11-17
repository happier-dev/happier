import * as database from './actionIdsDatabaseV1.js';
import type { PluginActionContributionV2 } from '../plugins/actions/v2.js';
import { pluginActionDeclarationIsReadOnlyForInput } from '../plugins/actions/readOnly.js';

type Metadata = Pick<PluginActionContributionV2,
    'title' | 'dangerLevel' | 'readOnly' | 'placementBindings' | 'confirmation' | 'confirmationWhen'
    | 'approvalScope' | 'approvalInputCustody' | 'secretInputPaths'> & Readonly<{
        /** C6 policy metadata; U0 declarations omit agent/MCP until P3 admission. */
        agentDefault: 'allow' | 'ask' | 'authority' | Readonly<{ read: 'allow'; write: 'ask' }>;
    }>;

const read = { dangerLevel: 'safe', readOnly: true, placementBindings: [], agentDefault: 'allow' } satisfies Omit<Metadata, 'title'>;
const write = { dangerLevel: 'writesRemote', readOnly: false, agentDefault: 'ask' } as const;

/** C6's one presentation/classification owner. Missing producers contribute no callable Action. */
export const databaseActionMetadata = {
    [database.DATABASE_TARGETS_LIST_ACTION_ID_V1]: { ...read, title: 'List databases' },
    [database.DATABASE_TARGETS_CONNECT_ACTION_ID_V1]: {
        ...write, dangerLevel: 'writesLocal', title: 'Connect database', placementBindings: ['primary'],
        confirmation: { title: 'Connect this database?' },
    },
    [database.DATABASE_TARGETS_FORGET_ACTION_ID_V1]: {
        ...write, dangerLevel: 'writesLocal', title: 'Forget database', placementBindings: ['contextMenu'],
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
    [database.DATABASE_CELL_READ_ACTION_ID_V1]: {
        ...read, title: 'Read database cell', approvalInputCustody: 'live_only', secretInputPaths: ['key.[].value.value'],
    },
    [database.DATABASE_STATEMENT_RUN_ACTION_ID_V1]: {
        ...write, title: 'Run SQL', placementBindings: ['toolbar'],
        approvalInputCustody: 'live_only',
        agentDefault: { read: 'allow', write: 'ask' },
        readOnly: { op: 'eq', path: 'mode', value: 'read' },
        confirmationWhen: { op: 'eq', path: 'mode', value: 'write' },
        confirmation: { title: 'Run these database changes?' },
        secretInputPaths: ['statement.parameters.[].value', 'statements.[].parameters.[].value'],
    },
    [database.DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1]: {
        ...write, title: 'Explain SQL', placementBindings: ['toolbar'],
        agentDefault: { read: 'allow', write: 'ask' },
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
        ...write, title: 'Apply database changes', placementBindings: ['primary'], approvalScope: 'environment',
        approvalInputCustody: 'live_only',
        confirmation: { title: 'Apply these database changes?' },
        secretInputPaths: ['changes.[].key.[].value.value', 'changes.[].original.[].value.value', 'changes.[].values.[].value.cell.value'],
    },
    [database.DATABASE_ACCESS_READ_ACTION_ID_V1]: { ...read, title: 'Read database access' },
    [database.DATABASE_ACCESS_SET_ACTION_ID_V1]: {
        ...write, dangerLevel: 'writesLocal', title: 'Set database access', placementBindings: ['secondary'], agentDefault: 'authority',
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
} as const satisfies Record<database.DatabaseActionIdV1, Metadata>;

/** Admission and execution consume the declaration's canonical input predicate. */
export function databaseActionOperationClass(actionId: database.DatabaseActionIdV1, input: unknown): 'read' | 'write' {
    return pluginActionDeclarationIsReadOnlyForInput(databaseActionMetadata[actionId], input) ? 'read' : 'write';
}
