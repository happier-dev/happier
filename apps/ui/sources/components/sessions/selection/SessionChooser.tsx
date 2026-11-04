import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { KeyCombinationHint } from '@/components/ui/keyboard/KeyHint';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { SELECTION_LIST_LARGE_POPOVER_SIZE, type SelectionListKeyboardHint, type SelectionListPagination } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

import type { SessionChooserPageRequest } from './readSessionChooserPage';
import { SessionSelectionList } from './SessionSelectionList';
import type { SessionChooserPage } from './sessionChooserSource';

/** One request's worth of rows; the list asks for the next page as it scrolls, so this is no ceiling. */
const CHOOSER_PAGE_ROWS = 40;
const CHOOSER_WIDTH = 400;

export type SessionChooserPageReader = (request: SessionChooserPageRequest) => Promise<SessionChooserPage> | SessionChooserPage;

/**
 * The one way to choose a Session for something in hand (lab `sc`, MIS §4): a popover growing from its
 * chip, a bottom sheet on a phone. It owns the query and the pages; whoever opens it says where pages
 * come from (the main renderer's snapshot, or the Capture window's bridge), so it needs no Sync.
 */
export function SessionChooser(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<unknown>;
    /** The surface it must stay inside (the Capture window's paper); the window otherwise. */
    boundaryRef?: React.RefObject<unknown>;
    readPage: SessionChooserPageReader;
    selected: SessionAddress | null;
    /** Names the sheet on a phone and the listbox everywhere. */
    title: string;
    onSelect: (address: SessionAddress) => void;
    onNewSession?: () => void;
    /** Where a new Session would start ("storefront · MacBook Pro"). */
    newSessionContext?: string | null;
    /** What the Enter hint says ("send here", "copy here"). */
    enterHint: string;
    /** The key that opens it, shown where the keys go. */
    searchKey?: string | null;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            {...(props.boundaryRef ? { boundaryRef: props.boundaryRef } : {})}
            placement="top"
            gap={theme.space.s6}
            maxHeightCap={SELECTION_LIST_LARGE_POPOVER_SIZE.maxHeightCap}
            maxWidthCap={CHOOSER_WIDTH}
            portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
            phonePresentation="sheet"
            accessibilityLabel={props.title}
            containerStyle={styles.container}
            onRequestClose={props.onClose}
        >
            {({ maxHeight }) => (
                <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={false}>
                    <ChooserList {...props} maxHeight={maxHeight} />
                </FloatingOverlay>
            )}
        </Popover>
    );
}

function ChooserList(props: Readonly<{
    readPage: SessionChooserPageReader;
    selected: SessionAddress | null;
    title: string;
    onSelect: (address: SessionAddress) => void;
    onNewSession?: () => void;
    newSessionContext?: string | null;
    enterHint: string;
    searchKey?: string | null;
    onClose: () => void;
    maxHeight: number;
}>) {
    const [query, setQuery] = React.useState('');
    const [page, setPage] = React.useState<SessionChooserPage>({ rows: [], total: 0 });
    const [loadingMore, setLoadingMore] = React.useState(false);
    const latest = React.useRef(0);
    const { readPage } = props;
    const read = React.useCallback(async (offset: number, keep: SessionChooserPage['rows']) => {
        const request = ++latest.current;
        const next = await readPage({ query, offset, limit: CHOOSER_PAGE_ROWS });
        if (request === latest.current) setPage({ rows: [...keep, ...next.rows], total: next.total });
    }, [query, readPage]);
    React.useEffect(() => { void read(0, []); }, [read]);
    const hints = React.useMemo<readonly SelectionListKeyboardHint[]>(() => [
        { id: 'move', label: '↑↓', description: t('screenCapture.chooser.moveHint') },
        { id: 'choose', label: '↩', description: props.enterHint },
        { id: 'close', label: 'esc', description: t('common.close') },
    ], [props.enterHint]);
    const pagination = React.useMemo<SelectionListPagination>(() => ({
        hasMore: page.rows.length < page.total,
        loadingMore,
        requestKey: `${query}:${page.rows.length}`,
        onEndReached: () => {
            setLoadingMore(true);
            void read(page.rows.length, page.rows).finally(() => setLoadingMore(false));
        },
        loadingLabel: t('common.loading'),
        moreLabel: t('common.more'),
        retryLabel: t('common.retry'),
        endReachedLabel: '',
    }), [loadingMore, page, query, read]);
    return (
        <SessionSelectionList
            rows={page.rows}
            rowPresentation="inline"
            groupTitles={{ focused: t('screenCapture.chooser.openInHappier'), recent: t('screenCapture.chooser.recent') }}
            title={props.title}
            searchPlaceholder={t('screenCapture.chooser.search')}
            emptyStateLabel={t('screenCapture.chooser.empty')}
            testID="session-chooser"
            maxHeight={props.maxHeight}
            selectedOptionId={props.selected ? sessionAddressKey(props.selected) : undefined}
            inputValue={query}
            onChangeInputValue={setQuery}
            pagination={pagination}
            footerHints={hints}
            inputSuffix={props.searchKey ? <KeyCombinationHint label={props.searchKey} /> : undefined}
            pinnedRow={props.onNewSession ? (
                <NewSessionRow context={props.newSessionContext ?? null} onPress={props.onNewSession} />
            ) : undefined}
            onSelectSession={props.onSelect}
            onRequestClose={props.onClose}
        />
    );
}

function NewSessionRow(props: Readonly<{ context: string | null; onPress: () => void }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.pinned}>
            <SelectableRow
                presentation="menu"
                testID="session-chooser-new-session"
                title={t('screenCapture.chooser.newSession')}
                left={<Icon name="plus" size={18} color={theme.colors.text.secondary} />}
                right={props.context ? <Text variant="meta" numberOfLines={1} style={styles.context}>{props.context}</Text> : undefined}
                onPress={props.onPress}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 0,
    },
    pinned: {
        paddingVertical: theme.space.s4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    context: {
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
}));
