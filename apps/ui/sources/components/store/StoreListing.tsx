import * as React from 'react';
import { StoreListingPaneTitleContext, useStoreListingPaneTitleOverride } from './storeListingPaneTitle';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { StoreListingReference } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { DetailsPaneOpenAsPageButton } from '@happier-dev/plugin-ui/components';

import { DetailsPaneHost } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import {
  Stack,
  useIsFocused,
  useRouter,
  useLocalSearchParams,
} from '@/components/appShell/workspace/destinationRoute';
import { CapabilityListingDetail } from '@/components/capabilities/add/CapabilityAddModal';
import { PluginListingRoute } from '@/components/settings/plugins/listing/PluginListingRoute';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import {
  PluginListingPane,
  PluginListingScreen,
} from '@/components/settings/plugins/listing/PluginListingScreen';
import { buildStoreListingRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { usePluginsOpenItem } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import {
  SurfaceStateCard,
  type SurfaceStateSize,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { useStoreBrowserProfileScope, useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';

import {
  StoreListingController,
  type StoreListingState,
} from './StoreListingController';
import { StoreSoftwareRouteListing } from './StoreSoftwarePage';
import { StoreKindSurface } from './StoreKindSurface';
import { releaseMcpAddDraftContinuation } from '@/components/settings/mcpServers/add/mcpAddDraftState';

type Presentation = 'pane' | 'page';

const referenceKey = (reference: StoreListingReference) =>
  JSON.stringify(reference);

/** What a listing is (App, MCP server…): the bar or pane header above it says this, while the listing names the item. */
function storeListingKindWord(reference: StoreListingReference | null): string {
  const kind = reference?.type === 'software' ? 'software' : reference?.type === 'registryItem' ? reference.kind : null;
  return kind === null ? t('capabilities.store.listingLabel') : t(`capabilities.store.kindWord.${kind}`);
}

/**
 * Opens one item's listing from a Store directory (S40 §4.2): beside the page in the details pane where one fits,
 * otherwise (a phone, panes off) pushed as its own page, so Back returns to the page and its conditions.
 */
export function useOpenStoreListing(): (
  reference: StoreListingReference,
) => void {
  const besidePage = useDetailsPaneAvailable();
  const { openStore } = usePluginsOpenItem();
  const router = useRouter();
  const { project } = useStoreProjectScope();
  const machine = useStoreMachineScope();
  const browserProfile = useStoreBrowserProfileScope();
  const navigateWithFocusReturn = useNavigationFocusReturn();
  return React.useCallback(
    (reference) => {
      if (besidePage) {
        openStore(reference);
        return;
      }
      const result = runGuardedNavigation(() =>
        navigateWithFocusReturn(() => router.pushRetainingCurrent(buildStoreListingRoute(reference, project, undefined, machine, browserProfile))),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'useOpenStoreListing' });
    },
    [besidePage, openStore, router, project, machine, browserProfile, navigateWithFocusReturn],
  );
}

/** The selected listing's directory key, so the directory marks the row its pane shows. */
export function useStoreListingSelection(): StoreListingReference | null {
  return usePluginsOpenItem().storeOpenItem;
}

/**
 * A Store directory page with its listing pane (lab `h:kNotion`): the page stays where it is while the pane opens,
 * another row swaps the pane's content in place, and the pane can become the listing's own page.
 */
export function StoreListingPaneHost(
  props: Readonly<{
    /** The directory's identity; the selected pane is headed by what the item is, since its hero names it. */
    title: string;
    testID: string;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  const continuationId = React.useId();
  const {
    storeOpenItem,
    storeSelectionUnavailable,
    closeStore,
    openStoreAsPage,
  } = usePluginsOpenItem(continuationId);
  const key = storeOpenItem ? referenceKey(storeOpenItem) : null;
  const paneTitle = useStoreListingPaneTitleOverride(key);
  const listingTitle = paneTitle.title ?? (storeOpenItem ? storeListingKindWord(storeOpenItem) : props.title);
  const besidePage = useDetailsPaneAvailable();
  const paneSelectionKey = React.useRef<string | null>(null);
  const keepInPane = besidePage || (key !== null && key === paneSelectionKey.current);
  // Fresh phone selections push their own page. A listing already shown beside the directory stays with the shared
  // pane host across a resize, preserving its open install and letting the host choose the phone presentation.
  React.useEffect(() => {
    if (besidePage || key === null) paneSelectionKey.current = key;
    if (keepInPane || key === null) return;
    openStoreAsPage();
    // `key` names the selection; the callbacks follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [besidePage, key, keepInPane]);
  // A selection made from the keyboard swaps at once; a pointer's cross-fades (S40 §9).
  const immediate =
    key !== null &&
    Platform.OS === 'web' &&
    typeof document !== 'undefined' &&
    document.querySelector(':focus-visible') !== null;
  const details = React.useMemo(() => {
    if (!keepInPane || (!storeOpenItem && !storeSelectionUnavailable)) return null;
    return {
      header: {
        title: listingTitle,
        actions: storeOpenItem ? (
          <CorePluginUiPresentationScope>
            <DetailsPaneOpenAsPageButton
              testID={`${props.testID}.detailPane.openAsPage`}
              accessibilityLabel={t('capabilities.store.openAsPage')}
              onPress={openStoreAsPage}
            />
          </CorePluginUiPresentationScope>
        ) : undefined,
      },
      content:
        storeOpenItem && key ? (
          <WordCrossFade
            wordKey={key}
            durationMs={motionTokens.durationMs.fast}
            immediate={immediate}
            style={styles.fill}
          >
            <StoreListingPaneTitleContext.Provider value={paneTitle.set}>
              <StoreListingBody
                reference={storeOpenItem}
                presentation="pane"
                continuationId={continuationId}
                onClose={closeStore}
              />
            </StoreListingPaneTitleContext.Provider>
          </WordCrossFade>
        ) : (
          <ListingState
            kind="unavailable"
            size="details"
            testID="store.listing.unavailable"
            title={t('common.unavailable')}
          />
        ),
    };
    // `immediate` is read at the swap; it is not a reason to rebuild the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    keepInPane,
    closeStore,
    key,
    openStoreAsPage,
    props.testID,
    props.title,
    listingTitle,
    paneTitle.set,
    continuationId,
    storeSelectionUnavailable,
  ]);
  return (
    <DetailsPaneHost
      testID={`${props.testID}.detailPane`}
      mainColumn={{
        hideLabel: t('panes.mainColumn.hidePage', { title: props.title }),
        showLabel: t('panes.mainColumn.showPage', { title: props.title }),
        identity: { name: props.title },
      }}
      onCloseDetails={closeStore}
      details={details}
      main={props.children}
    />
  );
}

/** `/plugins/listing?selection=…`: the same listing body as the pane, as its own page (Open as page, a phone push). */
export function StoreListingPage(
  props: Readonly<{ reference: StoreListingReference }>,
): React.ReactElement {
  const router = useRouter();
  const params = useLocalSearchParams<{ continuation?: string }>();
  const maxWidth = useLayoutMaxWidthStyle();
  const close = React.useCallback(() => {
    releaseMcpAddDraftContinuation(typeof params.continuation === 'string' ? params.continuation : undefined);
    const result = runGuardedNavigation(() => router.back());
    if (result !== true)
      fireAndForget(result, { tag: 'StoreListingPage.close' });
  }, [params.continuation, router]);
  const kindWord = storeListingKindWord(props.reference);
  const pageTitle = useStoreListingPaneTitleOverride(referenceKey(props.reference));
  return (
    <StoreListingPageFrame>
      {/* The listing names the item under its mark; the bar above names only what it is (or the surface it handed to). */}
      <Stack.Screen options={{ headerTitle: pageTitle.title ?? kindWord }} />
      <View style={[styles.pageColumn, maxWidth]}>
        <StoreListingPaneTitleContext.Provider value={pageTitle.set}>
          <StoreListingBody
            reference={props.reference}
            presentation="page"
            continuationId={typeof params.continuation === 'string' ? params.continuation : undefined}
            onClose={close}
          />
        </StoreListingPaneTitleContext.Provider>
      </View>
    </StoreListingPageFrame>
  );
}

/** The pushed listing's existing page backing, independent of its route read. */
export function StoreListingPageFrame(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return <View style={styles.page} testID="store.listing.page">{props.children}</View>;
}

/** One listing body for the pane, the page and the Add dialog's details: the kind's own controller and detail. */
export function StoreListingBody(
  props: Readonly<{
    reference: StoreListingReference;
    presentation: Presentation;
    continuationId?: string;
    onClose: () => void;
  }>,
): React.ReactElement {
  const phone = useDeviceType() === 'phone';
  const focused = useIsFocused();
  const size: SurfaceStateSize =
    props.presentation === 'pane' ? 'details' : phone ? 'phone' : 'page';
  if (props.reference.type === 'software') return <ListingTitleFocus>
    <StoreSoftwareRouteListing reference={props.reference} pushed={phone && props.presentation === 'page'} onClose={props.onClose} />
  </ListingTitleFocus>;
  if (props.reference.type === 'storeKind' || (props.reference.type === 'registryItem' && props.reference.kind === 'app')) {
    const reference = props.reference;
    return <ListingTitleFocus><StoreKindSurface kind={reference.kind} mode="listing" presented={focused}
      selection={{ sourceId: reference.sourceId, itemId: reference.itemId,
        ...(reference.version ? { version: reference.version } : {}) }}
      pushed={phone && props.presentation === 'page'} size={size} onClose={props.onClose} /></ListingTitleFocus>;
  }
  const reference = props.reference;
  return (
    <ListingTitleFocus>
      <StoreListingController reference={reference} onClose={props.onClose} continuationId={props.continuationId}>
        {(state) => (
          <ListingContent
            state={state}
            presentation={props.presentation}
            pushed={phone && props.presentation === 'page'}
            size={size}
            onClose={props.onClose}
          />
        )}
      </StoreListingController>
    </ListingTitleFocus>
  );
}

/**
 * Opening a listing moves focus to its title (S40 §9), once its details have drawn; Escape then returns it to the
 * row it came from (the pane host's focus return). The heading takes focus without joining the tab order.
 */
function ListingTitleFocus(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  const ref = React.useRef<View>(null);
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node || typeof node.querySelector !== 'function') return;
    const focusTitle = () => {
      const heading = node.querySelector<HTMLElement>('[role="heading"], h1, h2');
      if (!heading) return false;
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      return true;
    };
    if (focusTitle()) return;
    const observer = new MutationObserver(() => {
      if (focusTitle()) observer.disconnect();
    });
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <View ref={ref} style={styles.fill}>
      {props.children}
    </View>
  );
}

function ListingContent(
  props: Readonly<{
    state: StoreListingState;
    presentation: Presentation;
    pushed: boolean;
    size: SurfaceStateSize;
    onClose: () => void;
  }>,
): React.ReactNode {
  const { state, size } = props;
  const router = useRouter();
  const loading = (
    <ListingState
      kind="loading"
      size={size}
      testID="store.listing.loading"
      title={t('common.loading')}
    />
  );
  const removed = (
    <ListingState
      kind="unavailable"
      size={size}
      testID="store.listing.removed"
      title={t('capabilities.store.listing.removed')}
      body={t('capabilities.store.listing.removedBody')}
    />
  );
  switch (state.kind) {
    case 'mcpServer':
      if (state.config && state.item)
        return (
          <CapabilityListingDetail
            config={state.config}
            item={state.item}
            onClose={props.onClose}
            pushed={props.pushed}
          />
        );
      return !state.config || state.resolving ? loading : removed;
    case 'skill':
      if (state.config && state.item)
        return (
          <CapabilityListingDetail
            config={state.config}
            item={state.item}
            onClose={state.requestClose}
            pushed={props.pushed}
          />
        );
      return !state.config || state.resolving ? loading : removed;
    case 'browserExtension':
      if (state.item)
        return (
          <CapabilityListingDetail
            config={state.config}
            item={state.item}
            onClose={props.onClose}
            pushed={props.pushed}
          />
        );
      return state.resolving ? loading : removed;
    case 'agent':
      if (state.item)
        return (
          <CapabilityListingDetail
            config={state.config}
            item={state.item}
            onClose={props.onClose}
            pushed={props.pushed}
          />
        );
      return state.resolving ? loading : removed;
    case 'plugin':
      if (state.listing)
        return props.presentation === 'pane' ? (
          <PluginListingPane {...state.listing} />
        ) : (
          <PluginListingScreen {...state.listing} />
        );
      if (state.resolving) return loading;
      return state.error ? (
        <ListingState
          kind="error"
          size={size}
          testID="store.listing.failed"
          title={t('capabilities.store.listing.failed')}
          body={state.error}
          action={{
            label: t('capabilities.store.retry'),
            onPress: state.refresh,
          }}
        />
      ) : (
        removed
      );
    case 'continuation':
      // A built-in Agent or a Provider: its home is its own Settings page.
      return (
        <ListingState
          kind="unavailable"
          size={size}
          testID="store.listing.continuation"
          title={t('capabilities.store.listingLabel')}
          action={{
            label: t('capabilities.store.listing.open'),
            onPress: () => {
              const href = state.href;
              const result = runGuardedNavigation(() =>
                router.push(href as never),
              );
              if (result !== true)
                fireAndForget(result, { tag: 'StoreListing.continuation' });
            },
          }}
        />
      );
    case 'unavailable':
      return (
        <ListingState
          kind="unavailable"
          size={size}
          testID="store.listing.unavailable"
          title={t('common.unavailable')}
        />
      );
  }
}

/** A listing that cannot show its details holds the pane's or page's own room: one state, centred, no resize. */
export function ListingState(
  props: Readonly<{
    kind: 'loading' | 'unavailable' | 'error';
    size: SurfaceStateSize;
    title: string;
    body?: string;
    action?: Readonly<{ label: string; onPress: () => void }>;
    testID: string;
  }>,
): React.ReactElement {
  return (
    <View style={styles.state}>
      <SurfaceStateCard
        testID={props.testID}
        kind={props.kind}
        size={props.size}
        title={props.title}
        {...(props.body ? { reason: props.body } : {})}
        {...(props.action ? { action: props.action } : {})}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  page: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
  pageColumn: { flex: 1, minHeight: 0, width: '100%', alignSelf: 'center' },
  state: { flex: 1, minHeight: 0, justifyContent: 'center' },
}));

const renderStoreListingPage = (reference: StoreListingReference) => <StoreListingPage reference={reference} />;

/** The app's `/plugins/listing` body: the one listing ingress, with the Store's page for Store selections. */
export const StoreListingRoute = React.memo(function StoreListingRoute() {
  return <PluginListingRoute renderStoreListing={renderStoreListingPage} />;
});
