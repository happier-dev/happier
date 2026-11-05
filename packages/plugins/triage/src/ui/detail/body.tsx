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
import { TriageDetailPanelNavigationProvider, type TriageDetailPanelNavigationV1 } from '@happier-dev/triage-sources/ui';

import { readTriageDetailTabSummaryV1, type TriageDetailTabV1 } from './tabs.js';
import { buildTriageDetailSurfaceInputV1 } from './input.js';

/** One source detail mount: the admitted surface, its strict input and its identity. */
export type TriageDetailSourceMountV1 = Readonly<{
  surface: PluginUiTargetedContributionSurfaceV1;
  input: TriageDetailSurfaceInputV1;
  /** The canonical entry+connection key, shared by this detail's panels. */
  instanceKey: string;
}>;

const SHARED_TAB_COPY = Object.freeze({
  overview: { key: 'plugins.triage.surface.detail.tab.overview', fallback: 'Overview' },
  activity: { key: 'plugins.triage.surface.detail.tab.activity', fallback: 'Activity' },
  files: { key: 'plugins.triage.surface.detail.tab.files', fallback: 'Files' },
  checks: { key: 'plugins.triage.surface.detail.tab.checks', fallback: 'Checks' },
});

const FILL_STYLE = Object.freeze({ flex: 1, minWidth: 0, minHeight: 0 });

export type TriageDetailTabSelectionV1 = Readonly<{
  value: string;
  onChange(tab: string): void;
  onAvailableTabsChange(tabs: readonly TriageDetailTabOptionV1[]): void;
}>;

export type TriageDetailTabOptionV1 = Readonly<{ id: string; title?: string }>;

/** The one panel mount: the source body asked for exactly this tab. */
export function TriageDetailPanelMount(props: Readonly<{
  mount: TriageDetailSourceMountV1;
  panel: string;
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
    }),
    [props.mount.input, props.panel],
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
  fallback: React.ReactNode;
  overviewLead?: React.ReactNode;
  overviewTail?: React.ReactNode;
}>): React.ReactElement {
  const [lastPanel, setLastPanel] = React.useState(props.panel ?? 'overview');
  if (props.panel !== null && props.panel !== lastPanel) setLastPanel(props.panel);
  const panel = props.panel ?? lastPanel;
  const overview = panel === 'overview';
  // The source detail surface is declared `content`: the frame owns its bounds and its scrolling, so every tab
  // scrolls here. A source panel's own list grows to its content inside it rather than scrolling itself.
  return (
    <ScrollArea style={FILL_STYLE}>
      <Stack gap={overview ? 'large' : 'medium'}>
        {overview ? props.overviewLead : null}
        <TriageDetailPanelMount mount={props.mount} panel={panel} fallback={props.fallback} />
        {overview ? props.overviewTail : null}
      </Stack>
    </ScrollArea>
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
  tabs: readonly TriageDetailTabV1[];
  entry: TriageDetailSourceMountV1;
  /** The linked fix PR's mount, when an issue or error group has one. */
  fixPullRequest: TriageDetailSourceMountV1 | null;
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
  const selected = props.tabSelection?.value ?? localSelected;
  const setSelected = props.tabSelection?.onChange ?? setLocalSelected;
  const hasSession = props.session !== undefined && props.session !== null;
  const availableTabs = React.useMemo<readonly TriageDetailTabOptionV1[]>(() => [
    ...props.tabs.map((tab) => ({
      id: tab.frameId,
      ...(tab.kind === 'source' ? { title: tab.titleKey === undefined ? tab.title : text(tab.titleKey, tab.title) } : {}),
    })), ...(hasSession ? [{ id: 'session' }] : []),
  ], [hasSession, props.tabs, text]);
  const reportAvailableTabs = props.tabSelection?.onAvailableTabsChange;
  React.useLayoutEffect(() => { reportAvailableTabs?.(availableTabs); }, [availableTabs, reportAvailableTabs]);
  // A source control that points at a sibling panel selects it through this one owner.
  const navigation = React.useMemo<TriageDetailPanelNavigationV1>(
    () => ({
      panels: props.tabs.map((tab) => tab.id),
      select: (panel) => {
        const tab = props.tabs.find((candidate) => candidate.id === panel);
        if (tab !== undefined) setSelected(tab.frameId);
      },
    }), [props.tabs, setSelected]);

  const selectedTab = props.tabs.find((tab) => tab.frameId === selected);
  const slot = selected === 'session' ? 'session' : selectedTab?.from ?? 'unavailable';

  return (
    <Stack style={FILL_STYLE}>
      <Tabs
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
                  fallback={props.fallback}
                  overviewLead={props.overviewLead}
                  overviewTail={props.overviewTail}
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
                      fallback={props.fallback}
                    />
                  </Stack>
                )}
              </Tabs.Item>
              <Tabs.Item value="session" title="" retention="discard">{props.session}</Tabs.Item>
              <Tabs.Item value="none" title="">
                <ScrollArea style={FILL_STYLE}>
                  <Stack gap="large">{props.overviewLead}{props.overviewTail}</Stack>
                </ScrollArea>
              </Tabs.Item>
              <Tabs.Item value="unavailable" title="">{props.fallback}</Tabs.Item>
            </Tabs>
          </TriageDetailPanelNavigationProvider>
        )}
      >
        {props.tabs.map((tab) => {
          // The declaring source's own fact, said beside the title ("Checks 2 failing"); absent says nothing.
          const summary = tab.summary === undefined ? null : readTriageDetailTabSummaryV1(tab.summary, locale);
          return (
            <Tabs.Item
              key={tab.frameId}
              value={tab.frameId}
              title={tab.kind === 'shared'
                ? text(SHARED_TAB_COPY[tab.id].key, SHARED_TAB_COPY[tab.id].fallback)
                : tab.titleKey === undefined ? tab.title : text(tab.titleKey, tab.title)}
              {...(summary === null ? {} : { badge: summary.value, badgeTone: summary.tone })}
            />
          );
        })}
        {props.session === undefined || props.session === null ? null : (
          <Tabs.Item
            key="session"
            value="session"
            title={text('plugins.triage.surface.detail.tab.session', 'Session')}
          />
        )}
      </Tabs>
    </Stack>
  );
}
