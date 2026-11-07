import * as React from 'react';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import type { WorkflowDefinitionCaptureRequestV1, WorkflowDefinitionCaptureResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { prepareWorkflowCaptureEditorEntry } from '@/components/workflows/authoring/useWorkflowMakeRepeatable';
import { captureWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type DiscussionWorkflowCaptureState = Readonly<{
    status: 'closed' | 'selection' | 'loading' | 'review' | 'failed';
    request: WorkflowDefinitionCaptureRequestV1 | null;
    draft: WorkflowDefinitionCaptureResultV1 | null;
    error: unknown;
}>;

/** Data/custody only. The capture-review composition consumes this hook without constructing a graph. */
export function useDiscussionWorkflowCapture(params: Readonly<{
    discussion: DiscussionAddressV1; accountLifetime: ServerAccountScopeLifetime;
}>) {
    const router = useRouter();
    const [state, setState] = React.useState<DiscussionWorkflowCaptureState>({ status: 'closed', request: null, draft: null, error: null });
    const matchesDiscussion = state.request === null || state.request.discussion.discussionId === params.discussion.discussionId
        && areServerProfileIdentifiersEquivalent(state.request.discussion.serverId, params.discussion.serverId);
    const displayed = matchesDiscussion && params.accountLifetime.isCurrent() ? state
        : { status: 'closed' as const, request: null, draft: null, error: null };
    const current = React.useRef(displayed);
    current.current = displayed;
    const pending = React.useRef<AbortController | null>(null);
    const reviewedRequest = React.useRef<WorkflowDefinitionCaptureRequestV1 | null>(null);
    React.useEffect(() => {
        const retire = params.accountLifetime.onRetire(() => {
            pending.current?.abort();
            reviewedRequest.current = null;
            setState({ status: 'closed', request: null, draft: null, error: null });
        });
        setState(previous => previous.request && (previous.request.discussion.discussionId !== params.discussion.discussionId
            || !areServerProfileIdentifiersEquivalent(previous.request.discussion.serverId, params.discussion.serverId))
            ? { status: 'closed', request: null, draft: null, error: null } : previous);
        return () => { retire.dispose(); pending.current?.abort(); };
    }, [params.accountLifetime, params.discussion.discussionId, params.discussion.serverId]);
    const review = React.useCallback(async (changes: Partial<Omit<WorkflowDefinitionCaptureRequestV1, 'discussion'>> = {}) => {
        pending.current?.abort();
        const request = { messageIds: [], ...current.current.request, ...changes, discussion: params.discussion };
        const retained = current.current.draft;
        if (!request.messageIds.length) {
            setState({ status: 'selection', request, draft: retained, error: null });
            return;
        }
        const controller = new AbortController();
        pending.current = controller;
        setState({ status: 'loading', request, draft: retained, error: null });
        try {
            const draft = await captureWorkflowDefinition({ ...request, accountLifetime: params.accountLifetime, signal: controller.signal });
            if (!controller.signal.aborted && pending.current === controller && params.accountLifetime.isCurrent()) {
                reviewedRequest.current = request;
                setState({ status: 'review', request, draft, error: null });
            }
        } catch (error) {
            if (!controller.signal.aborted && pending.current === controller && params.accountLifetime.isCurrent()) {
                setState({ status: 'failed', request, draft: retained, error });
            }
        }
    }, [params.accountLifetime, params.discussion]);
    const open = React.useCallback(async (messageIds?: readonly string[]) => {
        if (messageIds?.length) return review({ messageIds: [...messageIds], choices: undefined });
        const previous = current.current;
        setState({ ...previous, request: previous.request ?? { discussion: params.discussion, messageIds: [] },
            status: previous.error ? 'failed' : previous.draft && previous.request === reviewedRequest.current ? 'review' : 'selection' });
    }, [params.discussion, review]);
    const close = React.useCallback(() => { pending.current?.abort(); setState(previous => ({ ...previous, status: 'closed' })); }, []);
    const setInputPerRun = React.useCallback((name: string, perRun: boolean) => {
        const latest = current.current;
        if (latest.status !== 'review' || latest.request !== reviewedRequest.current || !latest.draft?.definition
            || latest.draft.provenance.workflow) return;
        const choices = new Map(latest.request?.choices?.map(choice => [choice.messageId, choice]));
        for (const step of latest.draft.steps) {
            if (step.inputName === name || step.participantInputName === name) {
                choices.set(step.messageId, { messageId: step.messageId, role: step.role,
                    ...choices.get(step.messageId), perRun });
            }
        }
        return review({ choices: [...choices.values()] });
    }, [review]);
    /** `name` is the panel's typed name; it names the unsaved draft and never changes the reviewed graph. */
    const openEditor = React.useCallback((options: Readonly<{ name?: string }> = {}) => {
        const latest = current.current;
        if (latest.status !== 'review' || latest.request !== reviewedRequest.current || latest.draft?.status !== 'ready') return;
        const name = options.name?.trim();
        const entry = prepareWorkflowCaptureEditorEntry(name ? { ...latest.draft, name } : latest.draft, params.accountLifetime);
        if (!entry) return;
        router.push(entry);
    }, [params.accountLifetime, router]);
    const canOpenEditor = displayed.status === 'review' && displayed.request === reviewedRequest.current && displayed.draft?.status === 'ready';
    return { state: displayed, canOpenEditor, open, close, review, setInputPerRun, openEditor };
}
