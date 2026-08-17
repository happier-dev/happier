import * as React from 'react';

import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    Action,
    Card,
    CodeBlock,
    defineUiSurface,
    EmptyState,
    ErrorState,
    LoadingState,
    Screen,
    ScrollArea,
    Stack,
    Status,
    Text,
    useLivePluginResource,
} from '@happier-dev/plugin-ui';

import {
    REVIEW_OPENABLE_CONTENT_VIEW_ID,
    readReviewOpenableContent,
    readReviewOpenableContentReference,
    type ReviewOpenableContentResult,
} from './reviewOpenableContent.js';

const REVIEW_SESSION_STATUS_VIEW_ID = 'review-session-status-details';
const PROJECT_COMPANION_ACTIVITY_VIEW_ID = 'project-companion-activity-log';
const PROJECT_COMPANION_PROJECT_ACTIVITY_VIEW_ID = 'project-companion-project-activity-log';

function readDestinationLocalId(context: RenderContext): string | null {
    const mount = context.surface.mount;
    return mount.kind === 'destination' ? mount.destination.localId : null;
}

type OpenableContentPanelState = Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; result: ReviewOpenableContentResult }>
    | Readonly<{ kind: 'error' }>;

function ReviewFrame({
    children,
    accessibilityLabel = 'Review assistant',
}: Readonly<{
    children: React.ReactNode;
    accessibilityLabel?: string;
}>) {
    return (
        <Screen>
            <ScrollArea accessibilityLabel={accessibilityLabel}>
                <Stack gap="medium">
                    {children}
                </Stack>
            </ScrollArea>
        </Screen>
    );
}

function ReviewOverview() {
    return (
        <ReviewFrame>
            <Card padding="large">
                <Stack gap="small">
                    <Status tone="success" label="Review assistant ready" />
                    <Text value="Review assistant" variant="title" />
                    <Text
                        value="Run the declared review action through the current host API."
                        tone="secondary"
                    />
                    <Action.Execute
                        action="review-summary"
                        input={{ transcript: 'Example review transcript' }}
                        title="Summarize review"
                    />
                </Stack>
            </Card>
        </ReviewFrame>
    );
}

function ReviewSessionStatusPanel({ activity = false }: Readonly<{ activity?: boolean }>) {
    const { resource, refresh } = useLivePluginResource('review-session-status');
    const title = activity ? 'Project Companion activity' : 'Review status';
    const refreshAction = <Action.Refresh title="Refresh status" onRefresh={refresh} />;
    const detailsAction = activity
        ? <Action.OpenSurface view={REVIEW_SESSION_STATUS_VIEW_ID} title="Open review details" variant="primary" />
        : undefined;
    const recoveryActions = activity ? (
        <Stack gap="small">
            {detailsAction}
            {refreshAction}
        </Stack>
    ) : refreshAction;

    if (resource.value === undefined) {
        if (resource.error) {
            return (
                <ReviewFrame accessibilityLabel={title}>
                    <ErrorState
                        title="Review status is unavailable"
                        description="The current Session status could not be loaded."
                        action={recoveryActions}
                    />
                </ReviewFrame>
            );
        }
        if (resource.pending !== 'idle') {
            return (
                <ReviewFrame accessibilityLabel={title}>
                    <LoadingState title="Loading review status" />
                </ReviewFrame>
            );
        }
        return (
            <ReviewFrame accessibilityLabel={title}>
                <EmptyState
                    title="No review status"
                    description="This Session does not have a declared review status yet."
                    action={recoveryActions}
                />
            </ReviewFrame>
        );
    }

    if (resource.value.contentType !== 'text/plain') {
        return (
            <ReviewFrame accessibilityLabel={title}>
                <ErrorState
                    title="Review status is unavailable"
                    description="The host returned an unsupported status format."
                    action={recoveryActions}
                />
            </ReviewFrame>
        );
    }

    const summary = new TextDecoder().decode(resource.value.bytes).trim();
    if (summary.length === 0) {
        return (
            <ReviewFrame accessibilityLabel={title}>
                <EmptyState
                    title="No review status"
                    description="This Session does not have a declared review status yet."
                    action={recoveryActions}
                />
            </ReviewFrame>
        );
    }

    const refreshing = resource.pending === 'refresh';
    const stale = resource.freshness === 'stale' || resource.error !== undefined;
    return (
        <ReviewFrame accessibilityLabel={title}>
            <Card padding="large">
                <Stack gap="small">
                    <Status
                        tone={stale ? 'warning' : 'success'}
                        label={refreshing
                            ? 'Refreshing review status'
                            : stale
                                ? 'Showing last known review status'
                                : 'Current review status'}
                        pulsing={refreshing}
                    />
                    <Text value={title} variant="title" />
                    <Text value={summary} selectable />
                    {detailsAction}
                    {refreshAction}
                </Stack>
            </Card>
        </ReviewFrame>
    );
}

function describeOpenableContentResult(result: Exclude<ReviewOpenableContentResult, Readonly<{
    status: 'ready';
}>>): Readonly<{ title: string; description: string }> {
    switch (result.status) {
        case 'tooLarge':
            return {
                title: 'Review file is too large',
                description: 'The selected file exceeds this viewer’s bounded 64 KB read limit.',
            };
        case 'changed':
            return {
                title: 'Review file changed',
                description: 'The file changed before a consistent snapshot could be read. Reload it to try again.',
            };
        case 'unsupported':
            return {
                title: 'Review file is unavailable',
                description: 'The current host cannot provide this selected file to the review viewer.',
            };
        case 'cancelled':
            return {
                title: 'Review file read was cancelled',
                description: 'Reload the selected file if the review is still needed.',
            };
        case 'unavailable':
            return {
                title: 'Review file is unavailable',
                description: 'The selected file is no longer available to this review viewer.',
            };
    }
}

function ReviewOpenableContentPanel({
    context,
    handle,
}: Readonly<{
    context: RenderContext;
    handle: string;
}>) {
    const [reloadToken, setReloadToken] = React.useState(0);
    const [state, setState] = React.useState<OpenableContentPanelState>({ kind: 'loading' });
    const reload = React.useCallback(() => setReloadToken((current) => current + 1), []);

    React.useEffect(() => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) controller.abort();
        setState({ kind: 'loading' });

        void readReviewOpenableContent(
            context.hostApi,
            { kind: 'workspaceFile', handle },
            controller.signal,
        ).then((result) => {
            if (!controller.signal.aborted) setState({ kind: 'ready', result });
        }).catch(() => {
            if (!controller.signal.aborted) setState({ kind: 'error' });
        });

        return () => {
            context.signal.removeEventListener('abort', abort);
            controller.abort();
        };
    }, [context.hostApi, context.signal, handle, reloadToken]);

    const reloadAction = <Action.Refresh title="Reload file" onRefresh={reload} />;
    if (state.kind === 'loading') {
        return (
            <ReviewFrame>
                <LoadingState title="Loading selected review file" />
            </ReviewFrame>
        );
    }
    if (state.kind === 'error') {
        return (
            <ReviewFrame>
                <ErrorState
                    title="Review file is unavailable"
                    description="The selected file could not be read through the host viewer API."
                    action={reloadAction}
                />
            </ReviewFrame>
        );
    }
    if (state.result.status !== 'ready') {
        const copy = describeOpenableContentResult(state.result);
        return (
            <ReviewFrame>
                <ErrorState {...copy} action={reloadAction} />
            </ReviewFrame>
        );
    }
    if (state.result.content.kind !== 'utf8') {
        return (
            <ReviewFrame>
                <ErrorState
                    title="Review file is unavailable"
                    description="The selected content is not text that this review viewer can present."
                    action={reloadAction}
                />
            </ReviewFrame>
        );
    }

    return (
        <ReviewFrame>
            <Card padding="large">
                <Stack gap="small">
                    <Status tone="success" label="Bounded review snapshot" />
                    <Text value="Selected review file" variant="title" />
                    <Text
                        value={`${state.result.mimeType} · ${state.result.sizeBytes} bytes`}
                        tone="secondary"
                        variant="caption"
                    />
                    <CodeBlock
                        code={state.result.content.text}
                        language={state.result.mimeType === 'text/markdown' ? 'markdown' : 'text'}
                    />
                    {reloadAction}
                </Stack>
            </Card>
        </ReviewFrame>
    );
}

/**
 * React Native renderer for both declared review destinations. The semantic
 * entry installs the package-local provider, so this surface consumes the
 * mounted host API without a second bridge, resource store, or lifecycle.
 */
function ReviewPanel(context: RenderContext) {
    const destinationLocalId = readDestinationLocalId(context);
    if (destinationLocalId === REVIEW_SESSION_STATUS_VIEW_ID) {
        return context.surface.target.kind === 'session'
            ? <ReviewSessionStatusPanel />
            : (
                <ReviewFrame>
                    <ErrorState
                        title="Review status is unavailable"
                        description="The review status view requires a Session target."
                    />
                </ReviewFrame>
            );
    }

    if (destinationLocalId === PROJECT_COMPANION_ACTIVITY_VIEW_ID) {
        return context.surface.target.kind === 'session'
            ? <ReviewSessionStatusPanel activity />
            : (
                <ReviewFrame accessibilityLabel="Project Companion activity">
                    <ErrorState
                        title="Project Companion activity is unavailable"
                        description="Open this activity from a Session so it can read that Session’s review status."
                    />
                </ReviewFrame>
            );
    }

    if (destinationLocalId === PROJECT_COMPANION_PROJECT_ACTIVITY_VIEW_ID) {
        return (
            <ReviewFrame accessibilityLabel="Project Companion activity">
                <ErrorState
                    title="Project Companion activity needs a Session"
                    description="Open the Session activity from its header to review the current Session status."
                />
            </ReviewFrame>
        );
    }

    if (destinationLocalId === REVIEW_OPENABLE_CONTENT_VIEW_ID) {
        const reference = readReviewOpenableContentReference(context.launchInput);
        return reference === undefined
            ? (
                <ReviewFrame accessibilityLabel="Selected review file">
                    <ErrorState
                        title="Review file is unavailable"
                        description="Open this viewer from a host-selected review file."
                    />
                </ReviewFrame>
            )
            : <ReviewOpenableContentPanel context={context} handle={reference.handle} />;
    }

    return <ReviewOverview />;
}

export const renderSurface = defineUiSurface(ReviewPanel);
