import { AutomationSubjectV1Schema, type AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { DatabaseTargetsListInputV1 } from '@happier-dev/database-protocol';
import { DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import type { AutomationSubjectKind } from '@happier-dev/plugin-sdk/automations';
import { ProjectSourcesListOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { SessionListActionResultV1Schema } from '@happier-dev/protocol/sessions/awareness/action';
import { DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { WorkflowSubjectsListResultV1Schema, type WorkflowSubjectsListRequestV1 }
    from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { PluginSubjectKindListInputV1Schema, PluginSubjectKindListResultV1Schema,
    type PluginSubjectKindListInputV1 } from '@happier-dev/protocol/plugins/contributions/subjectKinds';
import { readPluginAutomationSubjectKindV1, readPluginAutomationSubjectV1,
    type PluginAutomationSubjectKindDeclarationV1 } from '@happier-dev/protocol/automations/automationPluginSubjectV1';
import { readNonEmptyString, readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { ProjectsListResult } from '@/sync/ops/actions/listProjects';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowActionCallerContext } from './callWorkflowAction';
import { WorkflowActionError } from './workflowActionError';

export type AutomationSubjectPickerOption = Readonly<{
    subject: AutomationSubjectV1;
    label: string;
    description?: string;
}>;
export type AutomationEnvironmentSubject = Extract<AutomationSubjectV1, { kind: 'environment' | 'backup' }>;

/** A requested owner page, never an Account-wide inventory assembled by the picker. */
export type AutomationSubjectPickerPage = Readonly<{
    items: readonly AutomationSubjectPickerOption[];
    nextCursor: string | null;
    coverage: ProjectsListResult['coverage'];
}>;

export type AutomationSubjectPickerActionPageKind = Exclude<AutomationSubjectKind, { kind: 'database' }>;

/** Page demand comes from the caller or the list owner's existing default. */
export type AutomationSubjectPickerActionPageRequest =
    | Readonly<{ kind: Exclude<AutomationSubjectPickerActionPageKind, { kind: 'plugin' | 'healthCheck' | 'app' }>;
        cursor?: string }>
    | Readonly<{ kind: Extract<AutomationSubjectKind, { kind: 'app' }>; cursor?: string; query?: string; limit?: number }>
    | Readonly<{ kind: Extract<AutomationSubjectKind, { kind: 'healthCheck' }>;
        page: Omit<WorkflowSubjectsListRequestV1, 'kind'> }>
    | Readonly<{ kind: Extract<AutomationSubjectKind, { kind: 'plugin' }>;
        page: PluginSubjectKindListInputV1; subjectKinds: readonly PluginAutomationSubjectKindDeclarationV1[] }>;

/** Project an acknowledged page without reading its body or fetching a second page. */
export function projectAutomationSubjectPickerActionPage(input: Readonly<{
    kind: AutomationSubjectPickerActionPageKind; serverId: string; result: unknown;
    subjectKinds?: readonly PluginAutomationSubjectKindDeclarationV1[];
}>): AutomationSubjectPickerPage {
    const serverId = input.serverId;
    switch (input.kind.kind) {
        case 'healthCheck': {
            const page = WorkflowSubjectsListResultV1Schema.parse(input.result);
            return { items: page.subjects.map(item => ({ subject: item.subject, label: item.label })),
                nextCursor: page.nextCursor, coverage: page.nextCursor === null ? 'complete' : 'partial' };
        }
        case 'project': {
            const page = readRecord(input.result);
            if (!Array.isArray(page.items)) throw new Error('Expected Project page');
            const coverage = page.coverage;
            if (coverage !== 'complete' && coverage !== 'partial' && coverage !== 'unknown') {
                throw new Error('Expected Project coverage');
            }
            return { items: page.items.map(raw => {
                const item = readRecord(raw);
                const project = readRecord(item.project);
                const subject = AutomationSubjectV1Schema.parse({ kind: 'project',
                    serverId: project.serverId, projectKey: project.projectKey });
                return { subject, label: readNonEmptyString(item.label) ?? readNonEmptyString(item.rootPath) ?? String(project.projectKey) };
            }), nextCursor: null, coverage };
        }
        case 'machine': {
            const page = readRecord(input.result);
            if (!Array.isArray(page.items)) throw new Error('Expected Machine input page');
            return { items: page.items.map(raw => {
                const item = readRecord(raw);
                const subject = AutomationSubjectV1Schema.parse({ kind: 'machine', serverId, machineId: item.machineId });
                return { subject, label: readNonEmptyString(item.label) ?? String(item.machineId) };
            }), nextCursor: null, coverage: 'unknown' };
        }
        case 'app': {
            const page = ProjectSourcesListOutputV1Schema.parse(input.result);
            if (!page.ok) throw new Error(page.error);
            return { items: page.sources.map(source => ({ label: source.name,
                subject: { kind: 'app', serverId, projectSourceId: source.id } })),
            nextCursor: page.coverage.nextCursor, coverage: page.coverage.complete ? 'complete' : 'partial' };
        }
        case 'environment':
        case 'backup': {
            const page = DeploymentEnvironmentListResultV1Schema.parse(input.result);
            if (!page.ok) throw new Error(page.error);
            const kind = input.kind.kind;
            return { items: page.items.map(environment => ({ label: environment.name ?? environment.id,
                subject: { kind, serverId: environment.serverId, environmentId: environment.id } })), nextCursor: page.nextCursor,
            coverage: page.coverage ?? 'unknown' };
        }
        case 'session': {
            const page = SessionListActionResultV1Schema.parse(input.result);
            if ('view' in page) throw new Error('Expected Session summary page');
            const nextCursor = page.nextCursor ?? null;
            return { items: page.sessions.map(session => ({ label: session.title ?? session.id,
                subject: { kind: 'session', serverId, sessionId: session.id } })), nextCursor,
            coverage: nextCursor !== null || page.hasNext === true ? 'partial' : 'complete' };
        }
        case 'approvalProfile': {
            const page = ActionPolicyOutputSchemas['actions.policy.get'].parse(input.result);
            if (!('profiles' in page)) throw new Error('Expected Approval Profile page');
            return { items: page.profiles.map(profile => ({ label: profile.profile.name,
                subject: { kind: 'approvalProfile', serverId, profileId: profile.id } })), nextCursor: null, coverage: 'unknown' };
        }
        case 'plugin': {
            const page = PluginSubjectKindListResultV1Schema.parse(input.result);
            const kind = input.kind;
            return { items: page.items.map(item => {
                const admitted = readPluginAutomationSubjectV1({ ...kind, serverId, identity: item.identity,
                    subjectKinds: input.subjectKinds ?? [] });
                if (!admitted.ok) throw new WorkflowActionError({ message: admitted.code, rawCode: admitted.code });
                return { label: item.label, subject: admitted.subject };
            }), nextCursor: page.nextCursor, coverage: page.nextCursor === null ? 'complete' : 'partial' };
        }
    }
}

/** One explicitly demanded owner page through the incumbent Action/account lifetime. */
export async function readAutomationSubjectPickerActionPage(input: Readonly<{
    lifetime: ServerAccountScopeLifetime; signal?: AbortSignal;
    context?: WorkflowActionCallerContext;
}> & AutomationSubjectPickerActionPageRequest):
    Promise<AutomationSubjectPickerPage> {
    const serverId = input.lifetime.scope.serverId;
    if (input.kind.kind === 'environment' || input.kind.kind === 'backup') {
        const { createDeploymentReadTransport } = await import('@/components/projects/deployments/deploymentReadTransport');
        const result = await createDeploymentReadTransport(input.lifetime).readEnvironmentNames(input.lifetime.scope,
            { cursor: 'cursor' in input ? input.cursor : undefined }, { signal: input.signal ?? new AbortController().signal });
        if (!result.ok) throw new WorkflowActionError({ message: result.failure.code, rawCode: result.failure.code });
        return projectAutomationSubjectPickerActionPage({ kind: input.kind, serverId, result: { ok: true, ...result.value } });
    }
    const page = 'page' in input ? input.page : input;
    const read = resolveAutomationSubjectPickerListRead({ kind: input.kind, serverId,
        cursor: page.cursor, ...('limit' in page ? { limit: page.limit } : {}),
        ...('query' in page ? { query: page.query } : {}),
        ...('sources' in page ? { sources: page.sources } : {}) });
    const { callWorkflowAction } = await import('./callWorkflowAction');
    if (read.kind === 'plugin_contribution' && 'subjectKinds' in input) {
        const declaration = readPluginAutomationSubjectKindV1({ ...read, subjectKinds: input.subjectKinds });
        if (!declaration) throw new WorkflowActionError({ message: 'subject_kind_unavailable', rawCode: 'subject_kind_unavailable' });
        return callWorkflowAction({ actionId: 'action.invoke', input: {
            action: { pluginId: read.pluginId, localId: declaration.listAction },
            input: PluginSubjectKindListInputV1Schema.parse(input.page),
        }, accountLifetime: input.lifetime, context: { ...input.context, surface: 'ui', serverId }, signal: input.signal,
        parseResult: result => projectAutomationSubjectPickerActionPage({ kind: input.kind, serverId, result,
            subjectKinds: input.subjectKinds }) });
    }
    if (read.kind !== 'action') throw new Error('Expected subject list Action');
    return callWorkflowAction({ actionId: read.actionId, input: read.input, accountLifetime: input.lifetime,
        context: { ...input.context, surface: 'ui', serverId }, signal: input.signal,
        parseResult: result => projectAutomationSubjectPickerActionPage({ kind: input.kind, serverId, result }) });
}

/** Resolve a saved native identity without demanding its catalogue or its content body. */
export async function readAutomationSubjectPickerSelection(input: Readonly<{
    lifetime: ServerAccountScopeLifetime; subject: AutomationEnvironmentSubject; signal?: AbortSignal;
}>): Promise<AutomationSubjectPickerOption | null> {
    const { createDeploymentReadTransport } = await import('@/components/projects/deployments/deploymentReadTransport');
    const result = await createDeploymentReadTransport(input.lifetime).readEnvironmentNames(
        { ...input.lifetime.scope, serverId: input.subject.serverId }, { environmentId: input.subject.environmentId },
        { signal: input.signal ?? new AbortController().signal });
    if (!result.ok) throw new WorkflowActionError({ message: result.failure.code, rawCode: result.failure.code });
    const page = projectAutomationSubjectPickerActionPage({ kind: { kind: input.subject.kind },
        serverId: input.subject.serverId, result: { ok: true, ...result.value } });
    const option = page.items[0];
    return option ? { ...option, subject: input.subject } : null;
}

export type AutomationSubjectPickerListRead =
    | Readonly<{ kind: 'action'; actionId: ActionId; serverId: string; input: Readonly<Record<string, unknown>> }>
    | Readonly<{ kind: 'database'; actionId: typeof DATABASE_TARGETS_LIST_ACTION_ID_V1; input: DatabaseTargetsListInputV1 }>
    | Readonly<{ kind: 'database_scope_required' }>
    | Readonly<{ kind: 'plugin_contribution'; serverId: string; pluginId: string; subjectKindId: string }>;

/** Selection uses each resource's existing read owner; declarations and admission remain elsewhere. */
export function resolveAutomationSubjectPickerListRead(input: Readonly<{
    kind: AutomationSubjectKind;
    serverId: string;
    cursor?: string;
    query?: string;
    limit?: number;
    sources?: WorkflowSubjectsListRequestV1['sources'];
    databaseScope?: DatabaseTargetsListInputV1['scope'];
}>): AutomationSubjectPickerListRead {
    const serverId = input.serverId;
    const paged = { serverId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
    switch (input.kind.kind) {
        case 'session': return { kind: 'action', actionId: 'session.list', serverId,
            input: input.cursor === undefined ? {} : { cursor: input.cursor } };
        case 'project': return { kind: 'action', actionId: 'projects.list', serverId, input: { serverId } };
        case 'app': return { kind: 'action', actionId: 'projects.sources.list', serverId, input: { ...paged,
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.limit === undefined ? {} : { limit: input.limit }) } };
        case 'environment':
        case 'backup': return { kind: 'action', actionId: 'deployments.environments.list', serverId, input: paged };
        case 'machine': return { kind: 'action', actionId: 'machines.list', serverId, input: { serverId, refresh: true } };
        case 'approvalProfile': return { kind: 'action', actionId: 'actions.policy.get', serverId, input: { profiles: true } };
        case 'database': return input.databaseScope === undefined ? { kind: 'database_scope_required' }
            : { kind: 'database', actionId: DATABASE_TARGETS_LIST_ACTION_ID_V1, input: { scope: input.databaseScope } };
        case 'healthCheck': return { kind: 'action', actionId: 'workflow.subjects.list', serverId,
            input: { kind: 'healthCheck', ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                ...(input.sources === undefined ? {} : { sources: input.sources }) } };
        case 'plugin': return { kind: 'plugin_contribution', serverId,
            pluginId: input.kind.pluginId, subjectKindId: input.kind.subjectKindId };
    }
}
