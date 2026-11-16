import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierListDetailLayout, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { InboxContentList, type InboxView as InboxContentView } from '@/components/inbox/InboxContent';
import { createInboxItemRoute, readInboxView, inboxHostsNoticePage, resolveInboxItemPageRoute, type InboxItemDetailContext, type InboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { findInboxItemForFocus, readInboxItemSelectionKey } from '@/components/inbox/inboxItemNavigation';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { countInboxMentions, countInboxNeedsYou, countInboxUpdates } from '@/components/inbox/inboxCounts';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Header } from '@/components/navigation/Header';
import { NavigationTitleChromeProvider, PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';
import { useCollectionRailWidth } from '@/components/ui/lists/collection/useCollectionRailWidth';
import {
    InboxModelBoundary,
    useInboxModel,
    type InboxModel,
} from '@/hooks/inbox/useInboxModel';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';
import { useInboxItemNavigation } from '@/hooks/inbox/useInboxItemNavigation';
import { InboxKeyHints } from '@/components/inbox/InboxKeyHints';
import { selectInboxItemsForView } from '@/components/inbox/inboxItems';
import { useDestinationFocus, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    phoneTabs: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s4,
    },
}));

// The detail draws a session, a run page or an approval page: loaded when something is selected, so
// the Inbox list (and a phone, which never shows the pane) does not carry those screens.
const InboxItemDetail = retryableLazy<React.ComponentProps<typeof import('@/components/inbox/detail/InboxItemDetail')['InboxItemDetail']>>(() => import('@/components/inbox/detail/InboxItemDetail')
    .then((module) => ({ default: module.InboxItemDetail })));

/**
 * Beside the detail the list keeps room for a row's title, its line and its inline answer; the
 * detail keeps room for an approval page's decision row and a transcript's messages. Below their
 * sum the Inbox is the list alone and rows open their item's own page.
 */
const INBOX_DETAIL_MIN_WIDTH_PX = 440;
/** The list is the wider pane (lab P4: share 0.6, minimum 400): a row's title and its inline answer must not truncate. */
const INBOX_LIST_MIN_WIDTH_PX = 400;
const INBOX_LIST_PREFERRED_RATIO = 0.6;

const InboxViewContent = React.memo(function InboxViewContent(props: Readonly<{ focusedItem?: InboxItemFocus | null }>) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const model = useInboxModel();
    const router = useRouter();
    // Lab `phone-P4`: on a phone the page carries the Inbox's large title itself (the Home hub's hero
    // step), with the view control under it and no purpose line; the tabs and groups say what it holds.
    // Wide layouts have no navigation title either: the page header carries it beside the control.
    const phone = !useIsTablet();
    // `/inbox?item=` (a Boards card) classifies the selected row; where the list is
    // the whole page, the item's own page opens instead (`OpenFocusedItemPage`).
    const focusedItem = props.focusedItem ?? null;
    const params = useLocalSearchParams<{ view?: string | string[] }>();
    const routedView = readInboxView(params.view);
    const view = routedView ?? 'needs_you';
    const setView = React.useCallback((next: InboxContentView) => {
        router.setParams({ view: next });
    }, [router]);
    const selectionRouteKey = readInboxItemSelectionKey(focusedItem);
    const selected = React.useMemo(() => findInboxItemForFocus(model.items, focusedItem),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the selection is identified by its key, not its object.
        [model.items, selectionRouteKey]);
    React.useEffect(() => {
        // Classify a new deep link once its owner is ready. A retained route
        // keeps its view even if opening/answering removed that item on Back.
        if (selectionRouteKey && selected && routedView === null) {
            setView(selected.view);
        }
    }, [selectionRouteKey, selected?.view, routedView, setView]);
    const select = React.useCallback((focus: InboxItemFocus) => { router.replace(createInboxItemRoute(focus, view) as never); }, [router, view]);
    const close = React.useCallback(() => { router.replace({ pathname: '/inbox', params: { view } } as never); }, [router, view]);
    const open = React.useCallback((route: string) => { router.push(route as never); }, [router]);
    const needsYouCount = countInboxNeedsYou(model);
    const updatesCount = countInboxUpdates(model);
    const mentionsCount = countInboxMentions(model);
    // Lab P4: Needs you says what waits, by kind ("2 approvals and 1 decision need you").
    const needsYouSummary = React.useMemo(() => {
        const counts = { approvals: 0, decisions: 0, blocked: 0 };
        for (const item of selectInboxItemsForView(model.items, 'needs_you')) {
            if (item.type === 'approval') counts.approvals += 1;
            else if (item.type === 'decision') counts.decisions += 1;
            else if (item.type === 'blocked') counts.blocked += 1;
        }
        return counts.approvals + counts.decisions + counts.blocked > 0 ? t('inbox.work.needsYouSummary', counts) : null;
    }, [model.items]);
    // Lab P4: what needs you, what changed and who mentioned you, as three views of one Inbox.
    // `beneathTitle`: a phone, or the narrow list beside an open item, where the control has the
    // column to itself and fits it: counts drop before a name is cut, then More takes the rest.
    const renderTabs = (beneathTitle: boolean) => (
        <SegmentedTabBar
            testIDPrefix="inbox.view"
            accessibilityLabel={t('inbox.work.tabs.a11y')}
            // A phone's control spans the width as a thumb target (lab `phone-P4`); the header's hugs its
            // labels beside the title at the control step (lab `inbox-I1`), not the compact one.
            segmentSizing={phone ? undefined : 'content'}
            overflow={beneathTitle ? { label: t('common.more'), testID: 'inbox.view:more' } : undefined}
            tabs={[
                { id: 'needs_you' as const, label: t('inbox.work.tabs.needsYou'), ...(needsYouCount > 0 ? { count: String(needsYouCount) } : {}) },
                { id: 'updates' as const, label: t('inbox.work.tabs.updates'), ...(updatesCount > 0 ? { count: String(updatesCount) } : {}) },
                { id: 'mentions' as const, label: t('inbox.work.tabs.mentions'), ...(mentionsCount > 0 ? { count: String(mentionsCount) } : {}) },
            ]}
            activeTabId={view}
            onSelectTab={setView}
        />
    );

    const hasRows = React.useMemo(() => selectInboxItemsForView(model.items, view).length > 0, [model.items, view]);
    const renderList = (onSelectItem: ((focus: InboxItemFocus) => void) | undefined) => {
        // Beside an open item the list is a narrow column and the header puts the control under the title.
        const tabs = renderTabs(phone || (onSelectItem !== undefined && focusedItem !== null));
        return (
        <NavigationTitleChromeProvider showsTitle={false}>
            {/* A page of work rows with their inline answers (lab `inbox-I1`): the wide column. */}
            {/* Windowed: only the rows near the viewport mount, however many approvals wait. */}
            <InboxContentList testID="inbox.screen" pageColumn="wide" model={model} presentation="screen" view={view}
                focusedItem={focusedItem} onSelectItem={onSelectItem} header={(
                    <>
                        <NavigationLargeTitleProvider largeTitle={phone}>
                            <PageHeader
                                title={t('tabs.inbox')}
                                description={phone ? undefined : view === 'needs_you' && needsYouSummary ? needsYouSummary : t('inbox.work.pageDescription')}
                                actions={phone ? undefined : tabs}
                            />
                        </NavigationLargeTitleProvider>
                        {phone ? <View style={styles.phoneTabs}>{tabs}</View> : null}
                    </>
                )} />
            {/* The keys run only beside the detail pane (`InboxKeyboardNavigation`), and only over rows to move through. */}
            {phone || onSelectItem === undefined || !hasRows ? null : <InboxKeyHints itemOpen={focusedItem !== null} />}
        </NavigationTitleChromeProvider>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            {/* A phone's bar belongs to the tab shell (`MainView`) and a web page's top edge to the shell's title strip;
                a second empty band would push the title down from where every other page has it. */}
            {phone || Platform.OS === 'web' ? null : (
                <Header
                    title={null}
                    headerLeft={() => null}
                    headerRight={() => null}
                    headerShadowVisible={false}
                    headerTransparent
                />
            )}
            {phone ? (
                <FocusedItemPage focus={focusedItem} list={renderList(undefined)} close={close} />
            ) : <InboxListDetail focusedItem={focusedItem} renderList={renderList} select={select} close={close}
                keyboard={{ model, view, open }} />}
        </View>
    );
});

/**
 * Arrow keys, Return and Escape through the list. Answered details stay until the person moves on. Only
 * where the item opens beside the list (`InboxListDetail`, split): a selection there is a pane, whereas where
 * the list is the whole page a selection would open the item's own page, so the keys would walk away from it.
 */
const InboxKeyboardNavigation = React.memo(function InboxKeyboardNavigation(props: Readonly<{
    model: InboxModel; view: InboxContentView; focusedItem: InboxItemFocus | null;
    select: (focus: InboxItemFocus) => void; close: () => void; open: (route: string) => void;
}>) {
    const { model, focusedItem } = props;
    const focused = useDestinationFocus();
    const visible = useDestinationVisibility();
    const enabled = focused && visible;
    useInboxItemNavigation({ items: model.items, focus: focusedItem, view: props.view, enabled,
        select: props.select, close: props.close, open: props.open, markOpened: model.markItemOpened });
    return null;
});

/**
 * Where the list is the whole page (a phone, or a window too narrow for the detail beside it), the
 * selected item opens its own page. A notice that points nowhere is its own content, so the Inbox is
 * its page: the notice replaces the list, and Back returns to it (lab P4 phone notice).
 */
function FocusedItemPage(props: Readonly<{ focus: InboxItemFocus | null; list: React.ReactNode; close: () => void }>) {
    const model = useInboxModel();
    const focus = props.focus;
    const notice = focus?.kind === 'notice' ? model.accountNotices.find(entry => entry.artifact.id === focus.id)?.header
        ?? model.openUsageNotices.find(entry => entry.artifact.id === focus.id)?.header ?? null : null;
    const hostsNotice = focus?.kind === 'notice' && (notice !== null || !model.isLoading)
        && inboxHostsNoticePage(notice, focus.serverId);
    if (focus && hostsNotice) {
        return (
            <React.Suspense fallback={<PaneLoadingFallback />}>
                <InboxItemDetail focus={focus} onClose={props.close} />
            </React.Suspense>
        );
    }
    return (
        <>
            {props.list}
            {focus ? <OpenFocusedItemPage focus={focus} notice={notice} /> : null}
        </>
    );
}

/**
 * A link to an item (`/inbox?item=`, from a Boards card or Artifacts) lands on that item's own page,
 * the same place a tapped row pushes. Replacing the Inbox entry keeps Back on the page the link came from.
 */
function OpenFocusedItemPage(props: Readonly<{ focus: InboxItemFocus; notice: InboxItemDetailContext['notice'] }>) {
    const router = useRouter();
    const model = useInboxModel();
    const notice = props.notice;
    const href = resolveInboxItemPageRoute(props.focus, { notice });
    React.useEffect(() => {
        if (props.focus.kind === 'notice' && !notice && model.isLoading) return;
        router.replace(href as never);
    }, [href, router, props.focus.kind, notice, model.isLoading]);
    return null;
}

/**
 * Lab `inbox-I1`: the list beside the selected item, selection held by the route's `item` parameter
 * so a link, Back and a reload all land on the same item. Where both panes do not fit, the list is
 * the page and a row opens its item's own page, as on a phone (DESIGN.md, Collections).
 *
 * With nothing selected the list is the whole page: no empty pane beside it. The Inbox does not land
 * on a first item, because opening an item is reading it (a session marks itself seen), and the Inbox
 * must not settle what the person has not looked at.
 */
const InboxListDetail = React.memo(function InboxListDetail(props: Readonly<{
    focusedItem: InboxItemFocus | null;
    select: (focus: InboxItemFocus) => void;
    close: () => void;
    renderList: (onSelectItem: ((focus: InboxItemFocus) => void) | undefined) => React.ReactNode;
    keyboard: Readonly<{ model: InboxModel; view: InboxContentView; open: (route: string) => void }>;
}>) {
    const { theme } = useUnistyles();
    const { fontScale } = useWindowDimensions();
    const railWidth = useCollectionRailWidth('inbox');
    const scale = Math.max(1, fontScale);
    return (
        <HappierListDetailLayout
            testID="inbox.layout"
            listTestID="inbox.list-pane"
            detailTestID="inbox.detail-pane"
            minListWidth={INBOX_LIST_MIN_WIDTH_PX * scale}
            minDetailWidth={INBOX_DETAIL_MIN_WIDTH_PX * scale}
            listWidthPx={railWidth.widthPx}
            onListWidthCommit={railWidth.commit}
            onListWidthReset={railWidth.reset}
            preferredListRatio={INBOX_LIST_PREFERRED_RATIO}
            labels={{
                resize: t('ui.resizableDockedPane.resizeA11y'),
                resizeHint: t('ui.resizableDockedPane.resizeHint'),
                resizeValue: (px) => t('ui.resizableDockedPane.resizeValue', { px }),
            }}
            stackedPane="list"
            // The hairline separates the list from an open item; a list alone has nothing to separate from.
            listStyle={props.focusedItem ? { borderRightWidth: 1, borderRightColor: theme.colors.border.default } : undefined}
            list={(layout) => (
                <>
                    {layout?.mode === 'split' ? (
                        <InboxKeyboardNavigation {...props.keyboard} focusedItem={props.focusedItem} select={props.select} close={props.close} />
                    ) : null}
                    <FocusedItemPage focus={layout?.mode === 'stacked' ? props.focusedItem : null}
                        list={props.renderList(layout?.mode === 'split' ? props.select : undefined)} close={props.close} />
                </>
            )}
            detail={props.focusedItem ? (
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <InboxItemDetail focus={props.focusedItem} onClose={props.close} />
                </React.Suspense>
            ) : null}
        />
    );
});

/**
 * The app shell owns the model in production. The boundary keeps isolated
 * stories/tests functional without mounting a second owner beneath the shell.
 */
export const InboxView = React.memo(function InboxView(props: Readonly<{
    /** The item the person came to see, from the route's `item` parameter. */
    focusedItem?: InboxItemFocus | null;
}>) {
    return (
        <InboxModelBoundary>
            <InboxViewContent focusedItem={props.focusedItem ?? null} />
        </InboxModelBoundary>
    );
});
