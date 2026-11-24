import * as React from 'react';

import { t } from '@/text';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { SessionSelectionList } from './SessionSelectionList';
import type { SessionSelectionPageReader } from './readSessionSelectionPage';

type ListProps = Pick<React.ComponentProps<typeof SessionSelectionList>,
    'title' | 'testID' | 'searchPlaceholder' | 'emptyStateLabel' | 'maxHeight' | 'onSelectSession' | 'onRequestClose'>;
type Page = Awaited<ReturnType<SessionSelectionPageReader>>;

/** The picker keeps only the pages the person asked to see. SelectionList owns text narrowing and scroll demand. */
export function PagedSessionSelectionList({ readPage, ...list }: ListProps & Readonly<{ readPage: SessionSelectionPageReader }>) {
    const [page, setPage] = React.useState<Page>({ rows: [], nextCursor: null });
    const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
    const demand = React.useRef<AbortController | null>(null);
    const read = React.useCallback((cursor: string | null) => {
        if (demand.current) return;
        const controller = new AbortController();
        demand.current = controller;
        setStatus('loading');
        void readPage(cursor, controller.signal).then(next => {
            if (controller.signal.aborted) return;
            if (next.nextCursor !== null && next.nextCursor === cursor) {
                setStatus('failed');
                return;
            }
            setPage(previous => ({
                nextCursor: next.nextCursor,
                rows: cursor === null ? next.rows : [...previous.rows, ...next.rows],
            }));
            setStatus('ready');
        }, () => {
            if (!controller.signal.aborted) setStatus('failed');
        }).finally(() => {
            if (demand.current === controller) demand.current = null;
        });
    }, [readPage]);
    React.useEffect(() => {
        read(null);
        return () => {
            demand.current?.abort();
            demand.current = null;
        };
    }, [read]);
    const isRecordingVisible = useSessionRecordingVisibility();
    const visibleRows = React.useMemo(() => page.rows.filter(row => isRecordingVisible(row.address)), [page.rows, isRecordingVisible]);
    const readMore = () => read(page.nextCursor);
    return <SessionSelectionList
        {...list}
        rows={visibleRows}
        pagination={status === 'ready' && page.nextCursor === null ? undefined : {
            hasMore: page.nextCursor !== null,
            loadingMore: status === 'loading',
            requestKey: page.nextCursor,
            onEndReached: readMore,
            onRetry: readMore,
            loadingLabel: t('common.loading'),
            moreLabel: t('common.more'),
            retryLabel: t('common.retry'),
            endReachedLabel: '',
            ...(status === 'failed' ? { error: t('common.error') } : {}),
        }}
    />;
}
