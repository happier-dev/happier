import * as React from 'react';
import { ScmPullRequestListResponseSchema, type ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { sessionScmPullRequestList } from '@/sync/ops/sessionScm';
import { t } from '@/text';

type PullRequest = Readonly<{ repository: string; number: number }>;

function readSelection(pullRequest: ScmPullRequestSummary): PullRequest | null {
    const repository = pullRequest.provider.nameWithOwner;
    return pullRequest.provider.kind === 'github' && repository && pullRequest.number
        ? { repository, number: pullRequest.number } : null;
}

function selectionId(selection: PullRequest): string {
    return `${selection.repository}#${selection.number}`;
}

type PullRequestChoice = Readonly<{ id: string; title: string; subtitle: string; selection: PullRequest }>;

/**
 * The existing SCM list for this session's repository, read only while a picker is open. The saved
 * pull request stays listed even before the list arrives or while SCM is unreachable.
 */
export function useSessionPullRequestChoices(props: Readonly<{
    open: boolean;
    sessionId: string;
    serverId?: string | null;
    selection: PullRequest | null;
}>): Readonly<{ status: 'loading' | 'ready' | 'failed'; choices: readonly PullRequestChoice[];
    selectedId: string | null; retry(): void }> {
    const [attempt, setAttempt] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{
        status: 'loading' | 'ready' | 'failed';
        pullRequests: readonly ScmPullRequestSummary[];
    }>>({ status: 'loading', pullRequests: [] });
    React.useEffect(() => {
        if (!props.open) return;
        let current = true;
        setRead((previous) => ({ ...previous, status: 'loading' }));
        void sessionScmPullRequestList(props.sessionId, { state: 'open' }, props.serverId)
            .then((raw) => {
                const result = ScmPullRequestListResponseSchema.parse(raw);
                if (!result.success) throw new Error(result.error);
                if (current) setRead({ status: 'ready', pullRequests: result.pullRequests });
            })
            .catch(() => { if (current) setRead((previous) => ({ ...previous, status: 'failed' })); });
        return () => { current = false; };
    }, [attempt, props.open, props.sessionId, props.serverId]);
    const selected = props.selection;
    const choices = React.useMemo(() => {
        const listed = read.pullRequests.flatMap((pullRequest): PullRequestChoice[] => {
            const selection = readSelection(pullRequest);
            return selection ? [{ id: selectionId(selection), title: `#${selection.number} · ${pullRequest.title}`,
                subtitle: selection.repository, selection }] : [];
        });
        return selected && !listed.some((choice) => choice.id === selectionId(selected))
            ? [{ id: selectionId(selected), title: `#${selected.number}`, subtitle: selected.repository, selection: selected }, ...listed]
            : listed;
    }, [read.pullRequests, selected]);
    const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
    return { status: read.status, choices, selectedId: selected ? selectionId(selected) : null, retry };
}

/** The pull request a PR/CI trigger watches, as a settings row (the trigger popover). */
export function SessionTriggerPullRequestPicker(props: Readonly<{
    testID: string;
    sessionId: string;
    serverId?: string | null;
    selection: PullRequest | null;
    onSelect: (selection: PullRequest) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const read = useSessionPullRequestChoices({ open, sessionId: props.sessionId, serverId: props.serverId, selection: props.selection });
    const items: DropdownMenuItem[] = read.choices.map((choice) => ({
        id: choice.id, title: choice.title, subtitle: choice.subtitle,
        testID: `${props.testID}-option:${choice.id}`,
    }));
    return (
        <>
            <DropdownMenu
                testID={props.testID}
                open={open}
                onOpenChange={setOpen}
                search
                items={items}
                selectedId={read.selectedId}
                itemTrigger={{ title: t('workflows.triggers.pullRequest.label'),
                    subtitle: t('workflows.triggers.pullRequest.description'),
                    detailFormatter: (selected) => selected?.title ?? t('workflows.triggers.then.choose') }}
                emptyLabel={read.status === 'loading' ? t('common.loading')
                    : read.status === 'failed' ? t('workflows.triggers.pullRequest.loadFailed') : t('workflows.triggers.pullRequest.empty')}
                onSelect={(id) => {
                    const selected = read.choices.find((choice) => choice.id === id)?.selection;
                    if (selected) props.onSelect(selected);
                    setOpen(false);
                }}
            />
            {read.status === 'failed' ? (
                <Item
                    testID={`${props.testID}-failed`}
                    title={t('workflows.triggers.pullRequest.loadFailed')}
                    rightElement={<RoundButton size="small" display="secondary" title={t('workflows.triggers.popover.tryAgain')}
                        onPress={() => { read.retry(); setOpen(true); }} />}
                    showChevron={false}
                />
            ) : null}
        </>
    );
}
