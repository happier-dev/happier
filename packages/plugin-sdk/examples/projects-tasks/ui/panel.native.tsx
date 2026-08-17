import * as React from 'react';

import type { ActionInputHints } from '@happier-dev/plugin-sdk/actions';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    Action,
    Button,
    Card,
    defineUiSurface,
    EmptyState,
    ErrorState,
    Form,
    List,
    LoadingState,
    Screen,
    Stack,
    Status,
    Text,
} from '@happier-dev/plugin-ui';
import {
    type PluginUiAccountCollectionForDefinition,
    type PluginUiCollectionQuerySnapshot,
    usePluginCollectionQuery,
    usePluginUiDataClient,
} from '@happier-dev/plugin-ui/data';

import { Tasks } from '../src/collections.js';

const PROJECT_SELECTOR_HINTS: ActionInputHints = {
    title: 'Choose a project',
    description: 'Enter the ID of an existing Project to review its open Tasks.',
    submitLabel: 'Show open tasks',
    fields: [{
        path: 'projectId',
        title: 'Project ID',
        description: 'This is an existing Account Collection row ID.',
        widget: 'text',
        required: true,
        placeholder: 'projectId',
    }],
};

function readText(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

const EMPTY_TASK_ROWS: PluginUiCollectionQuerySnapshot['rows'] = Object.freeze([]);
type CompletionNotice = Readonly<{ tone: 'success' | 'danger'; label: string }>;

function completionFailureNotice(error: unknown): CompletionNotice {
    if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'plugin_collection_conflict'
    ) {
        return {
            tone: 'danger',
            label: 'Task changed before it could be completed. Refresh tasks and try again.',
        };
    }
    return { tone: 'danger', label: 'Task could not be updated' };
}

type ProjectTasksHeaderProps = Readonly<{
    projectDraft: Record<string, unknown>;
    projectIssue?: string;
    onProjectDraftChange: (value: Record<string, unknown>) => void;
    onProjectSubmit: (value: Record<string, unknown>) => void;
}>;

function ProjectTasksHeader({
    projectDraft,
    projectIssue,
    onProjectDraftChange,
    onProjectSubmit,
}: ProjectTasksHeaderProps) {
    return (
        <>
            <Card padding="large">
                <Stack gap="small">
                    <Status tone="neutral" label="Account Collection workspace" />
                    <Text value="Projects and Tasks" variant="title" />
                    <Text
                        value="Review a Project’s direct Account Collection tasks and complete one with its current revision."
                        tone="secondary"
                    />
                </Stack>
            </Card>
            <Form
                hints={PROJECT_SELECTOR_HINTS}
                value={projectDraft}
                issues={{ projectId: projectIssue }}
                onChange={onProjectDraftChange}
                onSubmit={onProjectSubmit}
            />
        </>
    );
}

type OpenProjectTasksListProps = Readonly<{
    signal: AbortSignal;
    projectId: string;
    tasks: PluginUiAccountCollectionForDefinition<typeof Tasks>;
    header: React.ReactNode;
    completionNotice?: CompletionNotice;
    onCompletionNoticeChange: (notice: CompletionNotice | undefined) => void;
}>;

function OpenProjectTasksList({
    signal,
    projectId,
    tasks,
    header,
    completionNotice,
    onCompletionNoticeChange,
}: OpenProjectTasksListProps) {
    const [busyTaskId, setBusyTaskId] = React.useState<string | null>(null);
    const mounted = React.useRef(true);
    // The descriptor requires a Project ID. Mounting this subtree is the
    // author-owned admission point; the Data owner still owns its pager,
    // cursor/currentness, AccountChange wakeups, and cancellation thereafter.
    const query = usePluginCollectionQuery('tasks', 'openByProject', { projectId });

    React.useEffect(() => () => {
        mounted.current = false;
    }, []);

    const completeTask = React.useCallback(async (rowId: string) => {
        if (signal.aborted) return;
        setBusyTaskId(rowId);
        onCompletionNoticeChange(undefined);
        try {
            // UI-query rows deliberately contain only declared projections. A
            // direct reread gives Data the complete current row and exact CAS
            // revision before this author-owned user intent is persisted.
            const current = await tasks.get(rowId, { signal });
            if (signal.aborted) return;
            if (!current) {
                onCompletionNoticeChange({ tone: 'danger', label: 'Task is no longer available' });
                return;
            }
            await tasks.put({
                ...current.value,
                status: 'done',
            }, {
                expectedRevision: current.revision,
                signal,
            });
            if (!signal.aborted && mounted.current) {
                onCompletionNoticeChange({ tone: 'success', label: 'Task marked complete' });
            }
        } catch (error) {
            if (!signal.aborted && mounted.current) {
                onCompletionNoticeChange(completionFailureNotice(error));
            }
        } finally {
            if (!signal.aborted && mounted.current) {
                setBusyTaskId(null);
            }
        }
    }, [onCompletionNoticeChange, signal, tasks]);

    const refreshAction = <Action.Refresh title="Refresh tasks" onRefresh={query.refresh} />;

    const queryFeedback = query.status === 'error' && query.rows.length > 0
        ? (
            <ErrorState
                title="Open tasks could not be refreshed"
                description="Showing the last available Account Collection result. Refresh to try again."
                action={refreshAction}
            />
        )
        : undefined;

    let taskEmptyContent: React.ReactNode | undefined;
    if (query.rows.length === 0) {
        if (query.status === 'loading' || query.status === 'idle') {
            taskEmptyContent = <LoadingState title="Loading open tasks" description="Reading the current Account Collection." />;
        } else if (query.status === 'unavailable') {
            taskEmptyContent = (
                <ErrorState
                    title="Open tasks are unavailable"
                    description="The current Account Collection query is not available for this surface."
                    action={refreshAction}
                />
            );
        } else if (query.status === 'error') {
            taskEmptyContent = (
                <ErrorState
                    title="Open tasks could not be loaded"
                    description="Refresh to ask the Account Data owner for a current result."
                    action={refreshAction}
                />
            );
        } else if (query.status === 'ready') {
            taskEmptyContent = (
                <EmptyState
                    title="No open tasks"
                    description="This Project has no open Tasks in the current Account Collection."
                    action={refreshAction}
                />
            );
        }
    }

    return (
        <List
            accessibilityLabel="Projects and Tasks"
            style={{ flex: 1 }}
            items={query.rows}
            keyForItem={(row) => row.context.rowId}
            header={(
                <Stack gap="large">
                    {header}
                    {completionNotice ? <Status {...completionNotice} /> : null}
                    {query.rows.length > 0 ? (
                        <Stack gap="small">
                            <Status
                                tone={query.status === 'error' ? 'danger' : 'success'}
                                label={
                                    query.status === 'loading'
                                        ? 'Refreshing open tasks'
                                        : query.status === 'error'
                                            ? 'Last available open tasks'
                                            : 'Current open tasks'
                                }
                            />
                            <Text value="Open tasks" variant="title" />
                        </Stack>
                    ) : null}
                    {queryFeedback}
                </Stack>
            )}
            empty={taskEmptyContent}
            footer={query.rows.length > 0 && query.status !== 'error' ? (
                <Stack gap="medium">
                    {query.hasMore ? (
                        <Button title="Load more tasks" variant="secondary" onPress={query.loadMore} />
                    ) : null}
                    {refreshAction}
                </Stack>
            ) : undefined}
            renderItem={(row) => {
                const title = readText(row.fields.title, 'Untitled task');
                const dueDate = readText(row.fields.dueAt, 'date unavailable');
                return (
                    <List.Item
                        title={title}
                        subtitle="Tap to mark complete"
                        detail={`Due ${dueDate}`}
                        accessibilityLabel={`Mark ${title} complete`}
                        busy={busyTaskId === row.context.rowId}
                        disabled={busyTaskId !== null && busyTaskId !== row.context.rowId}
                        onPress={() => completeTask(row.context.rowId)}
                    />
                );
            }}
        />
    );
}

function ProjectsTasksPanel({ signal }: Readonly<{ signal: AbortSignal }>) {
    const dataClient = usePluginUiDataClient();
    const tasks = React.useMemo(() => dataClient.collection(Tasks), [dataClient]);
    const [projectDraft, setProjectDraft] = React.useState<Record<string, unknown>>({ projectId: '' });
    const [selectedProjectId, setSelectedProjectId] = React.useState('');
    const [projectIssue, setProjectIssue] = React.useState<string | undefined>();
    const [completionNotice, setCompletionNotice] = React.useState<CompletionNotice | undefined>();
    const chooseProject = React.useCallback((value: Record<string, unknown>) => {
        const projectId = typeof value.projectId === 'string' ? value.projectId.trim() : '';
        if (projectId.length === 0) {
            setProjectIssue('Enter an existing Project ID.');
            return;
        }
        setProjectIssue(undefined);
        setCompletionNotice(undefined);
        setSelectedProjectId(projectId);
    }, []);
    const header = (
        <ProjectTasksHeader
            projectDraft={projectDraft}
            projectIssue={projectIssue}
            onProjectDraftChange={setProjectDraft}
            onProjectSubmit={chooseProject}
        />
    );

    return (
        <Screen safeArea>
            {selectedProjectId.length > 0 ? (
                <OpenProjectTasksList
                    key={selectedProjectId}
                    signal={signal}
                    projectId={selectedProjectId}
                    tasks={tasks}
                    header={header}
                    completionNotice={completionNotice}
                    onCompletionNoticeChange={setCompletionNotice}
                />
            ) : (
                <List
                    accessibilityLabel="Projects and Tasks"
                    style={{ flex: 1 }}
                    items={EMPTY_TASK_ROWS}
                    keyForItem={(row) => row.context.rowId}
                    header={<Stack gap="large">{header}</Stack>}
                    empty={(
                        <EmptyState
                            title="Choose a project"
                            description="Open tasks appear here after you enter an existing Project ID."
                        />
                    )}
                    renderItem={() => null}
                />
            )}
        </Screen>
    );
}

function ProjectsTasksSurface(context: RenderContext) {
    return <ProjectsTasksPanel signal={context.signal} />;
}

export const renderSurface = defineUiSurface(ProjectsTasksSurface);
