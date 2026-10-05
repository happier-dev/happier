import * as React from 'react';

import {
  ScrollArea,
  Stack,
  Tabs,
  TargetedSurface,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { PluginUiTargetedContributionSurfaceV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageDetailTabV1 } from './tabs.js';

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
  onAvailableTabsChange(tabs: readonly string[]): void;
}>;

/** The one panel mount: the source body asked for exactly this tab. */
export function TriageDetailPanelMount(props: Readonly<{
  mount: TriageDetailSourceMountV1;
  panel: string;
  fallback: React.ReactNode;
}>): React.ReactElement {
  const input = React.useMemo(
    () => ({ ...props.mount.input, panel: props.panel }),
    [props.mount.input, props.panel],
  );
  return (
    <TargetedSurface
      surface={props.mount.surface}
      input={input}
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
  activityTail?: React.ReactNode;
}>): React.ReactElement {
  const [lastPanel, setLastPanel] = React.useState(props.panel ?? 'overview');
  if (props.panel !== null && props.panel !== lastPanel) setLastPanel(props.panel);
  const panel = props.panel ?? lastPanel;
  const overview = panel === 'overview';
  return (
    <ScrollArea
      style={FILL_STYLE}
      scrollEnabled={overview}
      contentContainerStyle={overview ? undefined : FILL_STYLE}
    >
      <Stack gap={overview ? 'large' : 'medium'} style={overview ? undefined : FILL_STYLE}>
        {overview ? props.overviewLead : null}
        <Stack style={overview ? undefined : FILL_STYLE}>
          <TriageDetailPanelMount mount={props.mount} panel={panel} fallback={props.fallback} />
        </Stack>
        {overview ? props.overviewTail : panel === 'activity' ? props.activityTail : null}
      </Stack>
    </ScrollArea>
  );
}

/**
 * The detail's tabbed body (r0.42): Triage's strip over the shared vocabulary
 * and any source-only tabs. One source detail instance receives changing panel
 * input. Source Tabs own their panel intervals; the retained source and Session
 * slots below withdraw activity when the reader leaves that entire slot.
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
  /** After the Activity panel: the live agent card. */
  activityTail?: React.ReactNode;
  /**
   * Triage's own last tab: the linked Session, live (plan 05 §4.6). Absent without a linked
   * Session, and never a source panel.
   */
  session?: React.ReactNode;
  fallback: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [localSelected, setLocalSelected] = React.useState<string>('overview');
  const selected = props.tabSelection?.value ?? localSelected;
  const setSelected = props.tabSelection?.onChange ?? setLocalSelected;
  const hasSession = props.session !== undefined && props.session !== null;
  const availableTabs = React.useMemo(() => [
    ...props.tabs.map((tab) => tab.id), ...(hasSession ? ['session'] : []),
  ], [hasSession, props.tabs]);
  const reportAvailableTabs = props.tabSelection?.onAvailableTabsChange;
  React.useLayoutEffect(() => { reportAvailableTabs?.(availableTabs); }, [availableTabs, reportAvailableTabs]);

  const selectedTab = props.tabs.find((tab) => tab.id === selected);
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
          <Tabs value={slot} onValueChange={() => {}} ariaLabel="" tabList="host" layout="fill">
            <Tabs.Item value="entry" title="" retention="retain">
              <SourceDetailInstance
                key={props.entry.instanceKey}
                mount={props.entry}
                panel={slot === 'entry' ? selected : null}
                fallback={props.fallback}
                overviewLead={props.overviewLead}
                overviewTail={props.overviewTail}
                activityTail={props.activityTail}
              />
            </Tabs.Item>
            <Tabs.Item value="fixPullRequest" title="" retention="retain">
              {props.fixPullRequest === null ? props.fallback : (
                <SourceDetailInstance
                  key={props.fixPullRequest.instanceKey}
                  mount={props.fixPullRequest}
                  panel={slot === 'fixPullRequest' ? selected : null}
                  fallback={props.fallback}
                />
              )}
            </Tabs.Item>
            <Tabs.Item value="session" title="" retention="retain">{props.session}</Tabs.Item>
            <Tabs.Item value="none" title="">
              <ScrollArea style={FILL_STYLE}>
                <Stack gap="large">{props.overviewLead}{props.overviewTail}</Stack>
              </ScrollArea>
            </Tabs.Item>
            <Tabs.Item value="unavailable" title="">{props.fallback}</Tabs.Item>
          </Tabs>
        )}
      >
        {props.tabs.map((tab) => (
          <Tabs.Item
            key={tab.id}
            value={tab.id}
            title={tab.kind === 'shared'
              ? text(SHARED_TAB_COPY[tab.id].key, SHARED_TAB_COPY[tab.id].fallback)
              : tab.titleKey === undefined ? tab.title : text(tab.titleKey, tab.title)}
          />
        ))}
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
