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

/** The existing SCM list for this session's repository, demanded only while its picker is open. */
export function SessionTriggerPullRequestPicker(props: Readonly<{
    testID: string;
    sessionId: string;
    selection: PullRequest | null;
    onSelect: (selection: PullRequest) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{
        status: 'loading' | 'ready' | 'failed';
        pullRequests: readonly ScmPullRequestSummary[];
    }>>({ status: 'loading', pullRequests: [] });
    React.useEffect(() => {
        if (!open) return;
        let current = true;
        setRead((previous) => ({ ...previous, status: 'loading' }));
        void sessionScmPullRequestList(props.sessionId, { state: 'open' })
            .then((raw) => {
                const result = ScmPullRequestListResponseSchema.parse(raw);
                if (!result.success) throw new Error(result.error);
                if (current) setRead({ status: 'ready', pullRequests: result.pullRequests });
            })
            .catch(() => { if (current) setRead((previous) => ({ ...previous, status: 'failed' })); });
        return () => { current = false; };
    }, [attempt, open, props.sessionId]);

    const selections = read.pullRequests.flatMap((pullRequest) => {
        const selection = readSelection(pullRequest);
        return selection ? [{ selection, title: `#${selection.number} · ${pullRequest.title}` }] : [];
    });
    const items: DropdownMenuItem[] = selections.map(({ selection, title }) => ({
        id: selectionId(selection), title, subtitle: selection.repository,
        testID: `${props.testID}-option:${selectionId(selection)}`,
    }));
    // The binding's selected PR stays visible even after it closes or while SCM is unreachable.
    const selected = props.selection;
    if (selected && !items.some((item) => item.id === selectionId(selected))) {
        items.unshift({ id: selectionId(selected), title: `#${selected.number}`, subtitle: selected.repository });
    }
    return (
        <>
            <DropdownMenu
                testID={props.testID}
                open={open}
                onOpenChange={setOpen}
                search
                items={items}
                selectedId={props.selection ? selectionId(props.selection) : null}
                itemTrigger={{ title: t('workflows.triggers.pullRequest.label'),
                    subtitle: t('workflows.triggers.pullRequest.description'),
                    detailFormatter: (selected) => selected?.title ?? t('workflows.triggers.then.choose') }}
                emptyLabel={read.status === 'loading' ? t('common.loading')
                    : read.status === 'failed' ? t('workflows.triggers.pullRequest.loadFailed') : t('workflows.triggers.pullRequest.empty')}
                onSelect={(id) => {
                    const selected = selections.find(({ selection }) => selectionId(selection) === id)?.selection
                        ?? (props.selection && selectionId(props.selection) === id ? props.selection : null);
                    if (selected) props.onSelect(selected);
                    setOpen(false);
                }}
            />
            {read.status === 'failed' ? (
                <Item
                    testID={`${props.testID}-failed`}
                    title={t('workflows.triggers.pullRequest.loadFailed')}
                    rightElement={<RoundButton size="small" display="secondary" title={t('workflows.triggers.popover.tryAgain')}
                        onPress={() => { setAttempt((value) => value + 1); setOpen(true); }} />}
                    showChevron={false}
                />
            ) : null}
        </>
    );
}
