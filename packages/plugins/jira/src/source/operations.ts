import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import type { JiraSourceContext } from '../api.js';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    TriageListInstancesInputV1Schema, TriageListInstancesResultV1Schema,
    TriageGetInputV1Schema, TriageScanInputV1Schema, TriageScanContinuationV1Schema,
    TriageSourceInstanceDraftV1Schema, isTriageSourceConnectedAccountInstanceV1,
    TriageListScopeUnitsInputV1Schema, TriageListScopeUnitsResultV1Schema,
    TriageSourceScopeUnitV1Schema, triageSourceBindingComponentsV1, projectTriageDisplayTextV1,
    type TriageListScopeUnitsResultV1, type TriageSourceScopeUnitV1,
    type TriageListInstancesResultV1, type TriageScanResultV1, type TriageGetResultV1,
    type TriageConfiguredSourceInstanceV1, type TriageSourceEntryLocalRefV1,
} from '@happier-dev/triage-protocol/v1';
import { readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';
import { JIRA_ACCOUNT_PURPOSE, JIRA_SORT_COLUMNS } from '../contracts.js';
import { createJiraClient, invalidJira, jiraCloudOrigin, jiraFailure, numericId, object, string, type JiraClient } from '../api.js';
import { readJiraConfiguration, readJiraIssue, projectJiraIssue, jiraTaskFields, type JiraConfiguration, type JiraIssue } from './model.js';
import { readJiraTaskCapabilities } from './metadata.js';
import { encodeJiraConfiguration, jiraConfiguredScopeUnits, jiraProjectIncluded, JiraProjectCursorSchema } from './configurationContract.js';

function sameAccount(a: ConnectedAccountRef, b: ConnectedAccountRef): boolean {
    return a.accountId === b.accountId && a.service.pluginId === b.service.pluginId && a.service.localId === b.service.localId;
}
async function listedAccounts(context: JiraSourceContext) {
    const outcome = await readTriageSourceAccountListingV1({ connectedAccounts: context.services.connectedAccounts,
        purpose: JIRA_ACCOUNT_PURPOSE, signal: context.signal });
    if (outcome.kind === 'failed') throw invalidJira('jira/accountListingUnavailable');
    return outcome.kind === 'unbound' ? { status: 'complete' as const, accounts: [] } : outcome.listing;
}

export async function listJiraInstances(input: unknown, context: JiraSourceContext): Promise<TriageListInstancesResultV1> {
    TriageListInstancesInputV1Schema.parse(input);
    try {
        const listing = await listedAccounts(context);
        const candidates: Extract<TriageListInstancesResultV1, { kind: 'complete' }>['candidates'][number][] = [];
        const failures: Extract<TriageListInstancesResultV1, { kind: 'complete' }>['failures'][number][] = [];
        let incomplete = listing.status !== 'complete';
        for (const entry of listing.accounts) {
            const binding = { purpose: JIRA_ACCOUNT_PURPOSE, account: entry.account };
            try {
                const origin = entry.connectedAccountOrigins.length === 1 ? jiraCloudOrigin(entry.connectedAccountOrigins[0]) : null;
                if (origin === null) throw invalidJira('jira/siteUndeclared');
                const configuration = encodeJiraConfiguration({ v: 2, scope: { kind: 'all' }, involvement: 'mine' });
                if (configuration === null) throw invalidJira('jira/configurationInvalid');
                const draft = TriageSourceInstanceDraftV1Schema.safeParse({
                    v: 1, binding, localInstanceKey: origin, keyStability: 'locatorDerived',
                    configuration,
                    locator: { v: 1, displayLabel: entry.displayName ?? new URL(origin).hostname,
                        displayPath: new URL(origin).hostname, webUrl: origin },
                });
                if (draft.success) candidates.push(draft.data); else incomplete = true;
            } catch (error) { failures.push({ binding, failure: jiraFailure(error) }); }
        }
        return TriageListInstancesResultV1Schema.parse({ kind: incomplete ? 'incomplete' : 'complete', candidates, failures });
    } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}

export async function openJiraInstance(instance: Pick<TriageConfiguredSourceInstanceV1, 'binding' | 'configuration' | 'localInstanceKey'>, context: JiraSourceContext,
    ref?: TriageSourceEntryLocalRefV1): Promise<{ client: JiraClient; configuration: JiraConfiguration }> {
    if (!isTriageSourceConnectedAccountInstanceV1(instance) || instance.binding.purpose !== JIRA_ACCOUNT_PURPOSE) throw invalidJira('jira/bindingInvalid');
    const configuration = readJiraConfiguration(instance.configuration.token);
    const separator = instance.localInstanceKey.lastIndexOf('#');
    const origin = jiraCloudOrigin(separator < 0 ? instance.localInstanceKey : instance.localInstanceKey.slice(0, separator));
    // Retained project instances keep their original key when explicitly reconfigured.
    if (origin === null || (separator >= 0 && !numericId(instance.localInstanceKey.slice(separator + 1)))) throw invalidJira('jira/instanceMismatch');
    if (ref !== undefined && (ref.kindId !== 'issue' || ref.collisionScope !== `jira:${origin}` || !numericId(ref.entryId))) throw invalidJira('jira/entryMismatch');
    const listing = await listedAccounts(context);
    const accountRef = instance.binding.account;
    const account = listing.accounts.find((row) => sameAccount(row.account, accountRef));
    if (account === undefined || account.connectedAccountOrigins.length !== 1 || jiraCloudOrigin(account.connectedAccountOrigins[0]) !== origin) throw invalidJira('jira/accountSiteMismatch');
    return { client: createJiraClient(context, accountRef, origin), configuration };
}

/** Jira REST v3 project/search owns visibility, search and offset paging. */
export async function listJiraScopeUnits(raw: unknown, context: JiraSourceContext): Promise<TriageListScopeUnitsResultV1> {
    const input = TriageListScopeUnitsInputV1Schema.parse(raw);
    try {
        const configuration = readJiraConfiguration(input.draft.configuration.token);
        if (input.mode === 'configured') return {
            kind: 'page', status: 'complete', selection: configuration.scope, units: jiraConfiguredScopeUnits(configuration),
        };
        const query = input.query ?? '';
        const boundary = computeCanonicalDomainSeparatedDigest('happier.jira.project-directory.v1',
            [...triageSourceBindingComponentsV1(input.draft.binding), input.draft.localInstanceKey]);
        let startAt = 0;
        if (input.cursor !== undefined) {
            let rawCursor: unknown;
            try { rawCursor = JSON.parse(input.cursor.token); } catch { throw invalidJira('jira/projectCursorInvalid'); }
            const cursor = JiraProjectCursorSchema.safeParse(rawCursor);
            if (!cursor.success || cursor.data.boundary !== boundary || cursor.data.query !== query) throw invalidJira('jira/projectCursorInvalid');
            startAt = cursor.data.startAt;
        }
        const { client } = await openJiraInstance(input.draft, context);
        const search = new URLSearchParams({ startAt: String(startAt), ...(query === '' ? {} : { query }) });
        const page = object(await client.request(`/rest/api/3/project/search?${search}`));
        if (!Array.isArray(page.values) || typeof page.isLast !== 'boolean'
            || page.startAt !== startAt || !Number.isSafeInteger(page.maxResults) || Number(page.maxResults) < 0) throw invalidJira('jira/projectPageInvalid');
        const units: TriageSourceScopeUnitV1[] = [];
        let invalid = false;
        for (const rawProject of page.values) {
            const project = object(rawProject);
            if (!numericId(project.id)) { invalid = true; continue; }
            const unit = TriageSourceScopeUnitV1Schema.safeParse({ id: project.id,
                label: projectTriageDisplayTextV1(string(project.name) ?? string(project.key) ?? project.id).value,
                ...(string(project.key) ? { secondaryText: projectTriageDisplayTextV1(String(project.key)).value } : {}),
            });
            if (unit.success) units.push(unit.data); else invalid = true;
        }
        const next = startAt + Number(page.maxResults);
        if (!page.isLast && (!Number.isSafeInteger(next) || next <= startAt)) throw invalidJira('jira/projectPageInvalid');
        return TriageListScopeUnitsResultV1Schema.parse({ kind: 'page', selection: configuration.scope, units,
            status: page.isLast && !invalid ? 'complete' : 'partial',
            ...(invalid ? { failure: { class: 'unsupportedContract', code: 'jira/projectRowsInvalid' } } : {}),
            ...(page.isLast ? {} : { nextCursor: TriageScanContinuationV1Schema.parse({ v: 1,
                token: JSON.stringify({ v: 1, boundary, query, startAt: next }) }) }),
        });
    } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}

export async function jiraViewer(client: JiraClient): Promise<string> {
    const id = string(object(await client.request('/rest/api/3/myself')).accountId);
    if (id === undefined) throw invalidJira('jira/viewerUnavailable');
    return id;
}
const SCAN_FIELDS = ['summary', 'project', 'status', 'issuetype', 'priority', 'creator', 'assignee', 'watches', 'created', 'updated', 'duedate', 'resolutiondate', 'parent', 'subtasks', 'issuelinks'];

type JiraDuePhase = 'dated' | 'missing';

function jql(configuration: JiraConfiguration, order: string, completedSinceMs?: number, duePhase?: JiraDuePhase): string {
    const clauses = { assignee: 'assignee = currentUser()', author: 'creator = currentUser()', subscribed: 'watcher = currentUser()',
        mine: '(assignee = currentUser() OR creator = currentUser() OR watcher = currentUser())', all: '' };
    const project = configuration.scope.kind === 'selected' ? `project IN (${configuration.scope.unitIds.join(',')})` : '';
    // Numeric Jira dates are epoch milliseconds, avoiding the provider viewer's timezone.
    const completion = completedSinceMs === undefined ? '' : `(statusCategory != Done OR resolved >= ${completedSinceMs})`;
    // Separate disjoint native partitions keep missing due dates last in both
    // directions, regardless of Jira's native EMPTY ordering.
    const due = duePhase === undefined ? '' : `duedate IS ${duePhase === 'dated' ? 'NOT ' : ''}EMPTY`;
    const selected = [project, clauses[configuration.involvement], completion, due].filter(Boolean).join(' AND ');
    return `${selected}${selected ? ' ' : ''}ORDER BY ${order}`;
}

export async function scanJiraSource(raw: unknown, context: JiraSourceContext): Promise<TriageScanResultV1> {
    const input = TriageScanInputV1Schema.parse(raw);
    const completedSinceMs = input.completed?.kindIds.includes('issue') ? input.completed.sinceMs : undefined;
    try {
        const sort = input.sort ?? { field: 'updated', direction: 'desc' } as const;
        const column = JIRA_SORT_COLUMNS.get(sort.field);
        if (column === undefined) throw invalidJira('jira/sortUnsupported');
        const direction = sort.direction.toUpperCase();
        const order = `${column} ${direction}, id ${direction}`;
        const { client, configuration } = await openJiraInstance(input.instance, context);
        let limit: number;
        let nextPageToken: string | undefined;
        let duePhase: JiraDuePhase | undefined = sort.field === 'due' ? 'dated' : undefined;
        if (input.page.kind === 'initial') limit = input.page.limit;
        else {
            const cursor = object(JSON.parse(input.page.continuation.token));
            if (cursor.v !== 1 || cursor.instance !== input.instance.localInstanceKey || cursor.configuration !== input.instance.configuration.token
                || cursor.sortField !== sort.field || cursor.sortDirection !== sort.direction
                || cursor.completedSinceMs !== completedSinceMs
                || !Number.isSafeInteger(cursor.limit) || Number(cursor.limit) < 1) throw invalidJira('jira/continuationInvalid');
            if (sort.field === 'due') {
                if (cursor.duePhase !== 'dated' && cursor.duePhase !== 'missing') throw invalidJira('jira/continuationInvalid');
                duePhase = cursor.duePhase;
            } else if (cursor.duePhase !== undefined) throw invalidJira('jira/continuationInvalid');
            nextPageToken = string(cursor.nextPageToken);
            if (nextPageToken === undefined && !(duePhase === 'missing' && cursor.nextPageToken === undefined)) throw invalidJira('jira/continuationInvalid');
            limit = Number(cursor.limit);
        }
        const viewer = await jiraViewer(client);
        const page = object(await client.request('/rest/api/3/search/jql', 'POST', { jql: jql(configuration, order, completedSinceMs, duePhase), fields: SCAN_FIELDS,
            maxResults: limit, ...(nextPageToken === undefined ? {} : { nextPageToken }) }));
        if (!Array.isArray(page.issues) || typeof page.isLast !== 'boolean' || page.issues.length > limit) throw invalidJira();
        const observations: Extract<TriageScanResultV1, { kind: 'complete' }>['observations'][number][] = [];
        let omitted = 0;
        for (const rawIssue of page.issues) {
            const issue = readJiraIssue(rawIssue);
            if (issue === null || !jiraProjectIncluded(configuration, String(object(issue.fields.project).id))) { omitted++; continue; }
            try { observations.push(projectJiraIssue(issue, client.origin, viewer)); } catch { omitted++; }
        }
        const evidence = omitted > 0 ? { kind: 'partial' as const, reason: 'jira/providerRowsInvalid', omittedItemCount: omitted } : { kind: 'walkFinished' as const };
        if (page.isLast && duePhase !== 'dated') return { kind: 'complete', observations, evidence };
        let next = string(page.nextPageToken);
        if (page.isLast) {
            // A short (possibly empty) transition page avoids a second native
            // query in this invocation. The next source page starts EMPTY.
            duePhase = 'missing';
            next = undefined;
        } else if (next === undefined || next === nextPageToken) throw invalidJira('jira/searchPageInvalid');
        const continuation = TriageScanContinuationV1Schema.parse({ v: 1, token: JSON.stringify({ v: 1,
            instance: input.instance.localInstanceKey, configuration: input.instance.configuration.token, limit, nextPageToken: next, sortField: sort.field, sortDirection: sort.direction,
            ...(duePhase === undefined ? {} : { duePhase }),
            ...(completedSinceMs === undefined ? {} : { completedSinceMs }) }) });
        return { kind: 'page', observations, evidence: omitted > 0 ? evidence : { kind: 'partial', reason: 'jira/providerContinuation' }, continuation };
    } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}

export async function readExactJiraIssue(client: JiraClient, configuration: JiraConfiguration, id: string): Promise<JiraIssue> {
    const issue = readJiraIssue(await client.request(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=*all&expand=names,schema`));
    if (issue === null || issue.id !== id || !jiraProjectIncluded(configuration, String(object(issue.fields.project).id))) throw invalidJira('jira/entryMoved');
    return issue;
}

export async function getJiraEntry(raw: unknown, context: JiraSourceContext): Promise<TriageGetResultV1> {
    const input = TriageGetInputV1Schema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input.instance, context, input.localRef);
        const issue = await readExactJiraIssue(client, configuration, input.localRef.entryId);
        const observation = projectJiraIssue(issue, client.origin, await jiraViewer(client));
        return { ...observation, taskFields: jiraTaskFields(issue, client.origin),
            snapshot: { ...observation.snapshot, taskCapabilities: await readJiraTaskCapabilities(client, issue) } };
    } catch (error) { return { kind: 'unresolved', localRef: input.localRef, failure: jiraFailure(error) }; }
}
