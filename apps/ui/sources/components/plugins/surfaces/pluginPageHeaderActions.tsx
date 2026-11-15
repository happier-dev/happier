import * as React from 'react';

import {
  useClaimedStackHeaderActions,
  usePageActionsLendKey,
  useStackHeaderActionsClaimed,
  useStackHeaderActionsPublisher,
  type LentHeaderMenuRow,
  type LentHeaderPrimary,
} from '@/components/navigation/stackHeaderActions';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/PageHeader';
import { NavigationHeaderActions } from '@/components/ui/layout/NavigationHeaderActions';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { usePluginSurfaceInteractionAvailable } from '@/components/plugins/shared/pluginSurfaceInteractionAvailability';
import type { PluginAccountHostedArtifactPublicationResult } from '@/sync/domains/plugins/availability/accountHostedArtifactPublication';
import { PaneMainHideButton } from '@/components/appShell/panes/mainColumn/PaneMainColumnControls';
import { CollectionSearchToggle } from '@/components/ui/lists/collection/CollectionList';
import { t } from '@/text';
import { splitHappierPagePrimaryOperation } from '@happier-dev/plugin-ui/presentation';

/** The page chrome's placement argument (same-realm binding; the chrome assignment type-checks it). */
type PageActionsPlacement = 'navigation' | 'page';

type PluginPageLentItem = Readonly<{ id: string; label: string; icon?: string; disabled?: boolean }>;

/** A Collection toolbar's `⋯` and primary handed with its actions (plugin-ui `HappierPageLentMenu`). */
export type PluginPageLentMenu = Readonly<{
  menu: React.ReactNode;
  items: readonly PluginPageLentItem[];
  onSelect: (id: string) => void;
  primary?: Readonly<{ label: string } & (
    | { onPress: () => unknown; menu?: undefined }
    | { menu: Readonly<{ items: readonly PluginPageLentItem[]; onSelect: (id: string) => void }>; onPress?: undefined }
  )>;
}>;

/** What a page lends a claiming header is data; the header draws it. */
const LENT_TO_HEADER = () => null;

function lentRows(items: readonly PluginPageLentItem[], onSelect: (id: string) => void, prefix: string): readonly LentHeaderMenuRow[] {
  return items.map((item): LentHeaderMenuRow => ({
    id: `${prefix}:${item.id}`,
    title: item.label,
    testID: `${prefix}.${item.id}`,
    iconName: resolvePluginUiIconName(item.icon),
    ...(item.disabled === true ? { disabled: true } : {}),
    onSelect: () => onSelect(item.id),
  }));
}

/** The host's `renderNavigationActions` for a plugin page header or Collection toolbar. */
export function renderPluginNavigationActions(actions: React.ReactNode, placement: PageActionsPlacement = 'navigation',
  more?: PluginPageLentMenu) {
  return <PluginPageHeaderActions actions={actions} placement={placement} more={more ?? null} />;
}

/**
 * The host's `renderSearchToggle` for a plugin page's large title: the magnifier every main screen's title line draws
 * (`MainScreenHeader`), so a plugin collection page's head is the same control, not a look-alike.
 */
export function renderPluginSearchToggle(toggle: React.ComponentProps<typeof CollectionSearchToggle>) {
  return <CollectionSearchToggle {...toggle} />;
}

type PluginArtifactHostingStatus = Readonly<{
  failed: boolean;
  /** A page header that shows the status registers here; the host's own line steps aside. */
  claim: () => () => void;
}>;

const PluginArtifactHostingStatusContext =
  React.createContext<PluginArtifactHostingStatus | null>(null);

/**
 * The outcome of hosting this page's UI on the Account (D3). Content never waits for it; when the
 * upload fails the page still works here, so the fact is a quiet "Only on this device" chip in the
 * page's own header row. A surface that draws no header (or a phone, whose native header has no
 * room) keeps the line above its content so the fact is never lost.
 */
export function PluginArtifactHostingStatusProvider(
  props: Readonly<{
    /** `null` while this mount has no Account upload in flight. */
    completion: Promise<PluginAccountHostedArtifactPublicationResult> | null;
    isCurrent: () => boolean;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  const [failed, setFailed] =
    React.useState<Promise<PluginAccountHostedArtifactPublicationResult> | null>(
      null,
    );
  const [claims, setClaims] = React.useState(0);
  React.useEffect(() => {
    const completion = props.completion;
    if (!completion) return;
    let active = true;
    void completion.then((result) => {
      if (active && props.isCurrent() && result.kind === 'unavailable')
        setFailed(completion);
    });
    return () => {
      active = false;
    };
  }, [props.completion, props.isCurrent]);
  const isFailed = failed !== null && failed === props.completion;
  const claim = React.useCallback(() => {
    setClaims((count) => count + 1);
    return () => setClaims((count) => count - 1);
  }, []);
  const status = React.useMemo(
    () => ({ failed: isFailed, claim }),
    [claim, isFailed],
  );
  return (
    <PluginArtifactHostingStatusContext.Provider value={status}>
      {isFailed && claims === 0 ? (
        <SurfaceFreshnessLine
          testID="plugin-account-hosting-failed"
          tone="warning"
          reason={t(
            'settingsPlugins.accountReleaseSelection.hostedStatusFailed',
          )}
        />
      ) : null}
      {props.children}
    </PluginArtifactHostingStatusContext.Provider>
  );
}

/** The header chip for a failed Account upload; claims the status so the host line steps aside. */
function PluginArtifactHostingChip(
  props: Readonly<{ status: PluginArtifactHostingStatus }>,
) {
  const { claim } = props.status;
  React.useLayoutEffect(() => claim(), [claim]);
  if (!props.status.failed) return null;
  return (
    <SurfaceFreshnessLine
      testID="plugin-account-hosting-failed"
      presentation="chip"
      tone="warning"
      reason={t(
        'settingsPlugins.accountReleaseSelection.hostedStatusFailedChip',
      )}
    />
  );
}

/**
 * The route's own actions (the machine a page runs on) joined to the plugin's header row, or the
 * plugin's actions handed to the native header on a phone; a `page` placement (an entity header)
 * keeps them in the row there too, as a core entity page does. While the plugin is offline its row is a
 * read-only snapshot, so the route's actions go back to the route's own bar: choosing another
 * machine is the way out of an offline one and must stay usable.
 */
function PluginPageHeaderActions(
  props: Readonly<{ actions: React.ReactNode; placement: PageActionsPlacement; more: PluginPageLentMenu | null }>,
) {
  const chromeShowsTitle = useNavigationTitleChromeShowsTitle() && props.placement === 'navigation';
  const live = usePluginSurfaceInteractionAvailable();
  const routeActions = useClaimedStackHeaderActions({ release: !live });
  // A header above this page that claims its actions (a Project's header over its plugin tab) draws the page's
  // primary as its + and the page's ⋯ rows in its own ⋯; this row then draws neither (D11). A read-only snapshot
  // and an entity header's row keep theirs here.
  const lendKey = usePageActionsLendKey();
  const more = props.more;
  const lends = lendKey !== null && live && props.placement === 'navigation' && !chromeShowsTitle
    && more !== null && (more.primary !== undefined || more.items.length > 0);
  const menuRows = React.useMemo(() => (!lends || more === null || more.items.length === 0 ? null
    : lentRows(more.items, more.onSelect, 'plugin-page-more')), [lends, more]);
  const primary = React.useMemo((): LentHeaderPrimary | null => {
    const lent = lends ? more?.primary : undefined;
    if (lent === undefined) return null;
    return lent.menu !== undefined
      ? { title: lent.label, menu: lentRows(lent.menu.items, lent.menu.onSelect, 'plugin-page-primary') }
      : { title: lent.label, onPress: () => { void lent.onPress(); } };
  }, [lends, more]);
  useStackHeaderActionsPublisher(lendKey ?? '', lends ? LENT_TO_HEADER : null, menuRows, primary);
  const claimed = useStackHeaderActionsClaimed(lendKey ?? '') && lends;
  const hosting = React.useContext(PluginArtifactHostingStatusContext);
  // The page's one filled action stays on the header's trailing side; the rest fold into overflow.
  const phone = React.useMemo(() => {
    if (!chromeShowsTitle) return null;
    const { primary, rest } = splitHappierPagePrimaryOperation(props.actions);
    return {
      primary: primary === null ? null : {
        title: primary.title,
        onPress: async () => { await primary.onPress(); },
        ...(primary.disabled ? { disabled: true } : {}),
        ...(primary.pending ? { loading: true } : {}),
        ...(primary.testID === undefined ? {} : { testID: primary.testID }),
      },
      rest,
    };
  }, [chromeShowsTitle, props.actions]);
  return phone !== null ? (
    <>
      {more?.menu ?? null}
      <NavigationHeaderActions primary={phone.primary} actions={phone.rest} />
    </>
  ) : (
    <>
      {claimed ? null : more?.menu ?? null}
      {hosting ? <PluginArtifactHostingChip status={hosting} /> : null}
      {routeActions}
      {claimed ? null : props.actions}
      {/* A plugin page that is a pane host's main column offers Hide like every page header there (D14); it draws nothing elsewhere. */}
      <PaneMainHideButton />
    </>
  );
}
