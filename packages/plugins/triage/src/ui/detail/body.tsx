import * as React from 'react';

import {
  ScrollArea,
  Stack,
  Tabs,
  TargetedSurface,
  Text,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import type { PluginUiTargetedContributionSurfaceV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { TriageDetailPageScrollProvider, TriageDetailPanelNavigationProvider, triageDetailPanelOwnsScrollerV1, type TriageDetailPanelNavigationV1, type TriageDetailFixPullRequestNavigationV1 } from '@happier-dev/triage-sources/ui';

import { readTriageDetailTabSummaryV1, type TriageDetailTabV1 } from './tabs.js';
import { buildTriageDetailSurfaceInputV1 } from './input.js';
import { TRIAGE_ENTRY_SESSION_COMPANION_V1 } from '../../composer/openEntryDetails.js';

/** One source detail mount: the admitted surface, its strict input and its identity. */
export type TriageDetailSourceMountV1 = Readonly<{
  surface: PluginUiTargetedContributionSurfaceV1;
  input: TriageDetailSurfaceInputV1;
  /** The canonical entry+connection key, shared by this detail's panels. */
  instanceKey: string;
}>;

const SHARED_TAB_COPY = Object.freeze({
  overview: { key: 'plugins.triage.surface.detail.tab.overview', fallback: 'Overview', glyph: 'info' },
  activity: { key: 'plugins.triage.surface.detail.tab.activity', fallback: 'Activity', glyph: 'list' },
  files: { key: 'plugins.triage.surface.detail.tab.files', fallback: 'Files', glyph: 'file' },
  checks: { key: 'plugins.triage.surface.detail.tab.checks', fallback: 'Checks', glyph: 'check' },
} as const);

export const TRIAGE_DETAIL_PAGE_KIND_V1 = Object.freeze({ pluginId: 'happier.triage', localId: 'entry' });

const FILL_STYLE = Object.freeze({ flex: 1, minWidth: 0, minHeight: 0 });

/**
 * A pushed (phone) detail's title and facts, led into the story that scrolls so they scroll away with the page
 * (UI refinements 2026-11-08, lab `merged-detail-*-phone`). The region provides it; the page Tabs place it (`lead`).
 */
const TriageDetailPageLeadContext = React.createContext<React.ReactNode>(null);

export function TriageDetailPageLeadProvider(props: Readonly<{ lead: React.ReactNode; children: React.ReactNode }>): React.ReactElement {
  return <TriageDetailPageLeadContext.Provider value={props.lead}>{props.children}</TriageDetailPageLeadContext.Provider>;
}

export type TriageDetailTabSelectionV1 = Readonly<{
  value: string;
  onChange(tab: string): void;
  onAvailableTabsChange?(tabs: readonly TriageDetailAvailableTabV1[] | null): void;
}>;

export type TriageDetailAvailableTabV1 = Readonly<{ value: string; title: string }>;

/** Publish changes from the rendered tab owner, independently of optional host chrome. */
export function useTriageDetailAvailableTabs(
  candidate: readonly TriageDetailAvailableTabV1[],
  report: TriageDetailTabSelectionV1['onAvailableTabsChange'],
): readonly TriageDetailAvailableTabV1[] {
  const current = React.useRef(candidate);
  if (current.current.length !== candidate.length || candidate.some((tab, index) =>
    tab.value !== current.current[index]?.value || tab.title !== current.current[index]?.title)) current.current = candidate;
  const tabs = current.current;
  React.useLayoutEffect(() => { report?.(tabs); }, [report, tabs]);
  React.useLayoutEffect(() => () => { report?.(null); }, [report]);
  return tabs;
}

/** Actions are an inline section beside the tabs, selected through the same source navigation seam. */
export type TriageDetailActionsNavigationV1 = Readonly<{
  open(): void;
  close(): void;
}>;

/** The one panel mount: the source body asked for exactly this tab. */
export function TriageDetailPanelMount(props: Readonly<{
  mount: TriageDetailSourceMountV1;
  panel: string;
  scrollOwner?: TriageDetailSurfaceInputV1['panelScrollOwner'];
  fallback: React.ReactNode;
}>): React.ReactElement {
  const built = React.useMemo(
    () => buildTriageDetailSurfaceInputV1({
      selection: {
        entryRef: props.mount.input.observation.entryRef,
        sourceInstanceId: props.mount.input.instance.instance.sourceInstanceId,
      },
      ...props.mount.input,
      linkedSessionsHasMore: props.mount.input.linkedSessionsHasMore === true,
      panel: props.panel,
      panelScrollOwner: props.scrollOwner,
    }),
    [props.mount.input, props.panel, props.scrollOwner],
  );
  if (built.kind !== 'admitted') return <>{props.fallback}</>;
  return (
    <TargetedSurface
      surface={props.mount.surface}
      input={built.input}
      instanceKey={props.mount.instanceKey}
      fallback={props.fallback}
    />
  );
}

/** Navigation memory only; selected events and settled pages belong to the source. */
function SourceDetailInstance(props: Readonly<{
  mount: TriageDetailSourceMountV1;
  panel: string | null;
  scrollOwner?: TriageDetailSurfaceInputV1['panelScrollOwner'];
  fallback: React.ReactNode;
  overviewLead?: React.ReactNode;
  overviewTail?: React.ReactNode;
  navigation: TriageDetailPanelNavigationV1;
  publishVisiblePanels(panels: readonly string[] | null): void;
  publishFilesCount(count: number | null): void;
  /** The phone detail scrolls as one page (D21): source Lists join it instead of owning a bounded scroller. */
  pageScroll?: boolean;
}>): React.ReactElement {
  const [lastPanel, setLastPanel] = React.useState({ id: props.panel ?? 'overview', scrollOwner: props.scrollOwner });
  if (props.panel !== null && (props.panel !== lastPanel.id || props.scrollOwner !== lastPanel.scrollOwner)) {
    setLastPanel({ id: props.panel, scrollOwner: props.scrollOwner });
  }
  const panel = props.panel ?? lastPanel.id;
  const scrollOwner = props.panel === null ? lastPanel.scrollOwner : props.scrollOwner;
  const overview = panel === 'overview';
  const pageScroll = props.pageScroll === true;
  const ownsScroller = !pageScroll && triageDetailPanelOwnsScrollerV1(scrollOwner);
  const navigation = React.useMemo(() => ({ ...props.navigation,
    publishVisiblePanels: props.publishVisiblePanels, publishFilesCount: props.publishFilesCount }),
    [props.navigation, props.publishVisiblePanels, props.publishFilesCount]);
  // The source declares whether its List owns scrolling. Keep ancestry stable across ownership changes so
  // retained panels keep their state and viewport while the frame only bounds source-owned Lists (QB-55/81).
  return (
    <TriageDetailPanelNavigationProvider navigation={navigation}>
    <TriageDetailPageScrollProvider pageScroll={pageScroll}>
    <ScrollArea
      style={FILL_STYLE}
      scrollEnabled={!ownsScroller}
      contentContainerStyle={ownsScroller ? FILL_STYLE : undefined}
    >
      <Stack gap={ownsScroller ? undefined : overview ? 'large' : 'medium'} style={ownsScroller ? FILL_STYLE : undefined}>
        {pageScroll && props.panel !== null ? <Tabs.Lead /> : null}
        {overview ? props.overviewLead : null}
        <TriageDetailPanelMount mount={props.mount} panel={panel} scrollOwner={scrollOwner} fallback={props.fallback} />
        {overview ? props.overviewTail : null}
      </Stack>
    </ScrollArea>
    </TriageDetailPageScrollProvider>
    </TriageDetailPanelNavigationProvider>
  );
}

/**
 * The detail's tabbed body (r0.42): Triage's strip over the shared vocabulary
 * and any source-only tabs. One source detail instance receives changing panel
 * input. Source Tabs own their panel intervals; retained source slots withdraw
 * activity, while the live Session slot retires when the reader leaves it.
 */
export function TriageDetailTabbedBody(props: Readonly<{
  tabSelection?: TriageDetailTabSelectionV1;
  actionsNavigation?: TriageDetailActionsNavigationV1;
  pushed?: boolean;
  tabs: readonly TriageDetailTabV1[];
  entry: TriageDetailSourceMountV1;
  /** The linked fix PR's mount, when an issue or error group has one. */
  fixPullRequest: TriageDetailSourceMountV1 | null;
  fixPullRequestNavigation?: TriageDetailFixPullRequestNavigationV1 | null;
  fixPullRequestsEmpty?: boolean;
  /** Above the rail: a waiting agent's permission card. */
  overviewLead?: React.ReactNode;
  /** After the source's steps: Triage's own — the fix PR and ③ the agent. */
  overviewTail: React.ReactNode;
  /**
   * Triage's own last tab: the linked Session, live (plan 05 §4.6). Absent without a linked
   * Session, and never a source panel.
   */
  session?: React.ReactNode;
  fallback: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const [localSelected, setLocalSelected] = React.useState<string>('overview');
  const requested = props.tabSelection?.value ?? localSelected;
  const setSelected = props.tabSelection?.onChange ?? setLocalSelected;
  const hasSession = props.session !== undefined && props.session !== null;
  type VisiblePanels = Readonly<{ instanceKey: string; panels: readonly string[] }> | null;
  const [entryPanels, setEntryPanels] = React.useState<VisiblePanels>(null);
  const [fixPanels, setFixPanels] = React.useState<VisiblePanels>(null);
  type FilesCount = Readonly<{ instanceKey: string; count: number | null }> | null;
  const [entryFilesCount, setEntryFilesCount] = React.useState<FilesCount>(null);
  const [fixFilesCount, setFixFilesCount] = React.useState<FilesCount>(null);
  const entryKey = props.entry.instanceKey;
  const fixKey = props.fixPullRequest?.instanceKey;
  const publishEntryPanels = React.useCallback((panels: readonly string[] | null) => {
    setEntryPanels(panels === null ? null : { instanceKey: entryKey, panels });
  }, [entryKey]);
  const publishFixPanels = React.useCallback((panels: readonly string[] | null) => {
    setFixPanels(panels === null || fixKey === undefined ? null : { instanceKey: fixKey, panels });
  }, [fixKey]);
  const publishEntryFilesCount = React.useCallback((count: number | null) => {
    setEntryFilesCount(previous => previous?.instanceKey === entryKey && previous.count === count ? previous : { instanceKey: entryKey, count });
  }, [entryKey]);
  const publishFixFilesCount = React.useCallback((count: number | null) => {
    setFixFilesCount(previous => fixKey === undefined ? null : previous?.instanceKey === fixKey && previous.count === count ? previous : { instanceKey: fixKey, count });
  }, [fixKey]);
  const tabs = React.useMemo(() => props.tabs.filter((tab) => {
    const answer = tab.from === 'entry' && entryPanels?.instanceKey === entryKey ? entryPanels
      : tab.from === 'fixPullRequest' && fixPanels?.instanceKey === fixKey ? fixPanels : null;
    return answer === null || answer.panels.includes(tab.id);
  }), [props.tabs, entryPanels, entryKey, fixPanels, fixKey]);
  const selected = tabs.some((tab) => tab.frameId === requested) || requested === 'session' && hasSession
    ? requested : tabs[0]?.frameId ?? 'overview';
  const candidateAvailableTabs = React.useMemo(() => [
    ...tabs.map(tab => ({ value: tab.frameId, title: tab.kind === 'shared'
      ? text(SHARED_TAB_COPY[tab.id].key, SHARED_TAB_COPY[tab.id].fallback)
      : tab.titleKey === undefined ? tab.title : text(tab.titleKey, tab.title) })),
    ...(hasSession ? [{ value: 'session', title: text('plugins.triage.surface.detail.tab.session', 'Session') }] : []),
  ], [tabs, hasSession, text]);
  const availableTabs = useTriageDetailAvailableTabs(candidateAvailableTabs, props.tabSelection?.onAvailableTabsChange);
  React.useEffect(() => { if (selected !== requested) setSelected(selected); }, [requested, selected, setSelected]);
  // A source control that points at a sibling panel selects it through this one owner.
  const navigation = React.useMemo<TriageDetailPanelNavigationV1>(
    () => ({
      panels: [...tabs.map((tab) => tab.id), ...(props.actionsNavigation === undefined ? [] : ['actions'])],
      ...(props.fixPullRequestNavigation == null ? {} : { fixPullRequest: props.fixPullRequestNavigation }),
      fixPullRequestsEmpty: props.fixPullRequestsEmpty === true,
      select: (panel) => {
        if (panel === 'actions' && props.actionsNavigation !== undefined) {
          props.actionsNavigation.open();
          return;
        }
        const tab = tabs.find((candidate) => candidate.id === panel);
        if (tab !== undefined) {
          props.actionsNavigation?.close();
          setSelected(tab.frameId);
        }
      },
    }), [props.actionsNavigation, props.fixPullRequestNavigation, props.fixPullRequestsEmpty, tabs, setSelected]);

  const selectedTab = tabs.find((tab) => tab.frameId === selected);
  const slot = selected === 'session' ? 'session' : selectedTab?.from ?? 'unavailable';
  const pageLead = React.useContext(TriageDetailPageLeadContext);

  return (
    <Stack style={FILL_STYLE}>
      <Tabs
        presentation="page"
        pageKind={TRIAGE_DETAIL_PAGE_KIND_V1}
        // The pushed detail's title and facts: above the tab row where it is drawn here, else leading the story.
        {...(pageLead === null ? {} : { lead: pageLead })}
        phonePresented={props.pushed}
        value={selected}
        onValueChange={setSelected}
        ariaLabel={text('plugins.triage.surface.detail.tabs', 'Entry detail')}
        // Panels are bounded regions (the Overview rail scrolls itself; Session hosts the live chat).
        layout="fill"
        sharedPanel={(
          <TriageDetailPanelNavigationProvider navigation={navigation}>
            <Tabs value={slot} onValueChange={() => {}} ariaLabel="" tabList="host" layout="fill">
              <Tabs.Item value="entry" title="" retention="retain">
                <SourceDetailInstance
                  key={props.entry.instanceKey}
                  mount={props.entry}
                  panel={slot === 'entry' ? selectedTab?.id ?? null : null}
                  scrollOwner={slot === 'entry' ? selectedTab?.scrollOwner : undefined}
                  fallback={props.fallback}
                  overviewLead={props.overviewLead}
                  overviewTail={props.overviewTail}
                  navigation={navigation}
                  publishVisiblePanels={publishEntryPanels}
                  publishFilesCount={publishEntryFilesCount}
                  pageScroll={props.pushed === true}
                />
              </Tabs.Item>
              <Tabs.Item value="fixPullRequest" title="" retention="retain">
                {props.fixPullRequest === null ? props.fallback : (
                  // These Files and Checks belong to the linked fix, not to this entry: said once, above them.
                  <Stack gap="small" style={FILL_STYLE}>
                    <Text
                      variant="micro"
                      tone="secondary"
                      value={text('plugins.triage.surface.detail.fixPr.from', 'From the linked fix: {title}', {
                        title: props.fixPullRequest.input.observation.snapshot.title,
                      })}
                      numberOfLines={1}
                    />
                    <SourceDetailInstance
                      key={props.fixPullRequest.instanceKey}
                      mount={props.fixPullRequest}
                      panel={slot === 'fixPullRequest' ? selectedTab?.id ?? null : null}
                      scrollOwner={slot === 'fixPullRequest' ? selectedTab?.scrollOwner : undefined}
                      fallback={props.fallback}
                      navigation={navigation}
                      publishVisiblePanels={publishFixPanels}
                      publishFilesCount={publishFixFilesCount}
                      pageScroll={props.pushed === true}
                    />
                  </Stack>
                )}
              </Tabs.Item>
              <Tabs.Item value="session" title="" retention="discard">{props.session}</Tabs.Item>
              <Tabs.Item value="none" title="">
                <ScrollArea style={FILL_STYLE}>
                  <Stack gap="large">{props.pushed === true && slot === 'none' ? <Tabs.Lead /> : null}{props.overviewLead}{props.overviewTail}</Stack>
                </ScrollArea>
              </Tabs.Item>
              <Tabs.Item value="unavailable" title="">{props.fallback}</Tabs.Item>
            </Tabs>
          </TriageDetailPanelNavigationProvider>
        )}
      >
        {tabs.map((tab, index) => {
          // The declaring source's own fact, said beside the title ("Checks 2 failing"); absent says nothing.
          const published = tab.from === 'entry' ? entryFilesCount : fixFilesCount;
          const count = tab.kind === 'shared' && tab.id === 'files' && published !== null && published.instanceKey === (tab.from === 'entry' ? entryKey : fixKey)
            ? published.count : null;
          const value = count == null ? tab.summary : { kind: 'number' as const, value: count, format: 'plain' as const };
          const summary = value === undefined ? null : readTriageDetailTabSummaryV1(value, locale);
          return (
            <Tabs.Item
              key={tab.frameId}
              value={tab.frameId}
              glyph={tab.kind === 'shared' ? SHARED_TAB_COPY[tab.id].glyph : 'file'}
              title={availableTabs[index]!.title}
              {...(summary === null ? {} : { badge: summary.value, badgeTone: summary.tone })}
            />
          );
        })}
        {!hasSession ? null : (
          <Tabs.Item
            key="session"
            value="session"
            // A page tab (the phone's) and the companion beside the story (Plan T `both`).
            kind="both"
            companion={TRIAGE_ENTRY_SESSION_COMPANION_V1}
            glyph="conversations"
            title={availableTabs[availableTabs.length - 1]!.title}
          />
        )}
      </Tabs>
    </Stack>
  );
}
