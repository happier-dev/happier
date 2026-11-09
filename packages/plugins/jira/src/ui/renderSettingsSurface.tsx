import * as React from 'react';
import { Button, ErrorState, Item, ItemGroup, LoadingState, Select, useExecutePluginAction, usePluginTranslation } from '@happier-dev/plugin-ui';
import { createTriageSourceSettingsSurface, type TriageSourceSettingsDraftFieldsPropsV1 } from '@happier-dev/triage-sources/ui';
import { TriageListScopeUnitsResultV1Schema, triageSourceBindingComponentsV1,
    type TriageScanContinuationV1, type TriageSourceScopeUnitV1 } from '@happier-dev/triage-protocol/v1';
import { JIRA_PLUGIN_ID, JIRA_SOURCE_ID, JIRA_ACCOUNT_PURPOSE, JIRA_ACTIONS } from '../contracts.js';
import { encodeJiraConfiguration, jiraConfiguredScopeUnits, jiraProjectIncluded, parseJiraConfiguration, selectJiraProjects,
    JiraConfigurationSchema, JiraIssueTypesResultSchema, type JiraConfiguration, type JiraIssueTypesResult } from '../source/configurationContract.js';

const issueTypesAction = { pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACTIONS.issueTypes };
const projectsAction = { pluginId: JIRA_PLUGIN_ID, localId: JIRA_ACTIONS.listScopeUnits };

function ReadyFields({ draft, busy, onChange, configuration }: TriageSourceSettingsDraftFieldsPropsV1 & { configuration: JiraConfiguration }): React.ReactElement {
    const text = usePluginTranslation();
    const update = (value: JiraConfiguration) => {
        const encoded = encodeJiraConfiguration(value);
        if (encoded !== null) onChange({ ...draft, configuration: encoded });
    };
    const latestDraft = React.useRef(draft);
    latestDraft.current = draft;
    const boundary = JSON.stringify([triageSourceBindingComponentsV1(draft.binding), draft.localInstanceKey]);
    const [projects, setProjects] = React.useState<readonly TriageSourceScopeUnitV1[]>([]);
    const [projectRead, setProjectRead] = React.useState({ pending: true, failed: false });
    const [projectAttempt, retryProjects] = React.useReducer((value: number) => value + 1, 0);
    const projectCompletion = React.useRef<Promise<void>>(Promise.resolve());
    const { execute: readProjects } = useExecutePluginAction(projectsAction);
    React.useEffect(() => {
        const controller = new AbortController();
        const previous = projectCompletion.current;
        const pending = (async () => {
            await previous;
            if (controller.signal.aborted) return;
            setProjects([]); setProjectRead({ pending: true, failed: false });
            let cursor: TriageScanContinuationV1 | undefined;
            try {
                do {
                    const execution = await readProjects({ v: 1, draft: latestDraft.current, ...(cursor ? { cursor } : {}) }, { signal: controller.signal });
                    if (controller.signal.aborted) return;
                    const parsed = execution.status === 'success' ? TriageListScopeUnitsResultV1Schema.safeParse(execution.result) : undefined;
                    if (!parsed?.success || parsed.data.kind === 'failed') throw new Error('jira/projectsUnavailable');
                    const page = parsed.data;
                    setProjects((previous) => [...new Map([...previous, ...page.units].map((unit) => [unit.id, unit])).values()]);
                    if (page.status === 'partial' && page.failure) throw new Error('jira/projectsPartial');
                    cursor = page.status === 'partial' ? page.nextCursor : undefined;
                    if (page.status === 'partial' && cursor === undefined) throw new Error('jira/projectsPartial');
                } while (cursor !== undefined);
                setProjectRead({ pending: false, failed: false });
            } catch {
                if (!controller.signal.aborted) setProjectRead({ pending: false, failed: true });
            }
        })();
        projectCompletion.current = pending;
        return () => controller.abort();
    // The native create-project directory depends on the site, not other edited fields.
    }, [boundary, projectAttempt, readProjects]);

    const [directory, setDirectory] = React.useState<{ projectId: string; result: JiraIssueTypesResult }>();
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const { execute } = useExecutePluginAction(issueTypesAction);
    const typeCompletion = React.useRef<Promise<void>>(Promise.resolve());
    React.useEffect(() => {
        const projectId = configuration.projectId;
        if (projectId === undefined) return;
        const controller = new AbortController();
        const previous = typeCompletion.current;
        const pending = (async () => {
            await previous;
            if (controller.signal.aborted) return;
            const input = latestDraft.current;
            const unavailable = { kind: 'failed' as const, failure: { class: 'transient' as const, code: 'jira/issueTypesUnavailable' } };
            try {
                const execution = await execute({ binding: input.binding, localInstanceKey: input.localInstanceKey,
                    configuration: input.configuration }, { signal: controller.signal });
                if (controller.signal.aborted) return;
                const parsed = execution.status === 'success' ? JiraIssueTypesResultSchema.safeParse(execution.result) : undefined;
                setDirectory({ projectId, result: parsed?.success ? parsed.data : unavailable });
            } catch {
                if (!controller.signal.aborted) setDirectory({ projectId, result: unavailable });
            }
        })();
        typeCompletion.current = pending;
        return () => controller.abort();
    }, [boundary, configuration.projectId, execute, attempt]);
    const result = directory?.projectId === configuration.projectId ? directory?.result : undefined;
    const available = [...new Map([...jiraConfiguredScopeUnits(configuration), ...projects].map((unit) => [unit.id, unit])).values()]
        .filter((unit) => jiraProjectIncluded(configuration, unit.id));
    if (configuration.projectId !== undefined && !available.some((unit) => unit.id === configuration.projectId)) {
        available.push({ id: configuration.projectId, label: configuration.projectId });
    }
    return <>
        <ItemGroup>
            <Item title={text('plugins.jira.settings.issues', 'Issues')} fieldAccessory accessoryOutsidePressable accessory={<Select presentation="field"
                label={text('plugins.jira.settings.issues', 'Issues')} disabled={busy} value={configuration.involvement}
                options={[
                    { value: 'mine', label: text('plugins.jira.settings.mine', 'My issues') },
                    { value: 'assignee', label: text('plugins.jira.settings.assignee', 'Assigned to me') },
                    { value: 'author', label: text('plugins.jira.settings.author', 'Created by me') },
                    { value: 'subscribed', label: text('plugins.jira.settings.subscribed', 'Subscribed') },
                    { value: 'all', label: text('plugins.jira.settings.all', 'All issues') },
                ]} onChange={(value) => {
                    const parsed = JiraConfigurationSchema.safeParse({ ...configuration, involvement: value });
                    if (parsed.success) update(parsed.data);
                }} />} />
            <Item title={text('plugins.jira.settings.createProject', 'Create issues in')}
                subtitle={text('plugins.jira.settings.createProjectDescription', 'Choose the default project for new issues.')}
                fieldAccessory accessoryOutsidePressable accessory={<Select presentation="field"
                    label={text('plugins.jira.settings.createProject', 'Create issues in')} disabled={busy} value={configuration.projectId ?? ''}
                    options={[{ value: '', label: text('plugins.jira.settings.typeNone', 'Not selected') },
                        ...available.map((unit) => ({ value: unit.id, label: unit.label }))]} onChange={(value) => {
                        if (typeof value !== 'string') return;
                        const { projectId: previousProject, issueTypeId: previousType, ...base } = configuration;
                        update({ ...base, ...(value ? { projectId: value } : {}) });
                    }} />} />
            {result?.kind === 'complete' && <Item title={text('plugins.jira.settings.type', 'Issue type for new issues')}
                subtitle={text('plugins.jira.settings.typeDescription', 'Choose a native issue type to enable creation in this project.')}
                fieldAccessory accessoryOutsidePressable accessory={<Select presentation="field" label={text('plugins.jira.settings.type', 'Issue type for new issues')}
                    disabled={busy} value={configuration.issueTypeId ?? ''} onChange={(value) => {
                        if (typeof value !== 'string') return;
                        const { issueTypeId: previousType, ...base } = configuration;
                        update({ ...base, ...(value ? { issueTypeId: value } : {}) });
                    }} options={[{ value: '', label: text('plugins.jira.settings.typeNone', 'Not selected') },
                        ...result.issueTypes.map((type) => ({ value: type.id, label: type.name }))]} />} />}
        </ItemGroup>
        {projectRead.pending && <LoadingState title={text('plugins.jira.settings.projectsLoading', 'Reading Jira projects')} />}
        {projectRead.failed && <ErrorState title={text('plugins.jira.settings.projectsUnavailable', 'Jira projects unavailable')}
            action={<Button variant="secondary" title={text('plugins.jira.settings.retry', 'Retry')} onPress={retryProjects} />} />}
        {configuration.projectId !== undefined && !result && <LoadingState title={text('plugins.jira.settings.typesLoading', 'Reading Jira issue types')} />}
        {configuration.projectId !== undefined && result?.kind === 'failed' && <ErrorState title={text('plugins.jira.settings.typesUnavailable', 'Jira issue types unavailable')}
            action={<Button variant="secondary" title={text('plugins.jira.settings.retry', 'Retry')} onPress={retry} />} />}
    </>;
}

function DraftFields(props: TriageSourceSettingsDraftFieldsPropsV1): React.ReactElement {
    const text = usePluginTranslation();
    const configuration = parseJiraConfiguration(props.draft.configuration.token);
    if (configuration === null) return <ErrorState title={text('plugins.jira.settings.invalid', 'Jira configuration unavailable')} />;
    return <ReadyFields {...props} configuration={configuration} />;
}

export const renderSurface = createTriageSourceSettingsSurface({
    sourceLocalId: JIRA_SOURCE_ID,
    pluginId: JIRA_PLUGIN_ID, listInstancesLocalActionId: JIRA_ACTIONS.listInstances,
    connectedAccountServiceLocalId: JIRA_ACCOUNT_PURPOSE, sourceDisplayName: 'Jira',
    connectedAccountPurpose: JIRA_ACCOUNT_PURPOSE, configuredInstanceKeyStability: 'locatorDerived', DraftFields,
    scopeSelection: {
        unitLabel: 'Projects', listScopeUnitsLocalActionId: JIRA_ACTIONS.listScopeUnits,
        readSelection: (draft) => parseJiraConfiguration(draft.configuration.token)?.scope ?? null,
        writeSelection: (draft, scope, units) => {
            const configuration = selectJiraProjects(draft.configuration.token, scope, units);
            return configuration === null ? null : { ...draft, configuration };
        },
    },
});
