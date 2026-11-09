import * as React from 'react';

import {
  BrandMark,
  Button,
  Dropdown,
  EmptyState,
  Icon,
  IconButton,
  PaneHeaderContent,
  Row,
  SessionChat,
  Stack,
  Status,
  Tabs,
  Text,
  usePluginTheme,
  usePluginTranslation,
  useSessionStates,
} from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1, TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import { useLinkedSessionOpen } from './useLinkedSessionOpen.js';
import { readTriageSessionTitle } from './sessionTitle.js';
import { TRIAGE_DETAIL_PAGE_KIND_V1, useTriageDetailAvailableTabs, type TriageDetailTabSelectionV1 } from './body.js';
import { useTriageUnlinkLinkedEntry } from '../../sessions/cockpit/useUnlinkLinkedEntry.js';
import { TRIAGE_ENTRY_SESSION_COMPANION_V1 } from '../../composer/openEntryDetails.js';

const FILL_STYLE = Object.freeze({ flex: 1, minWidth: 0, minHeight: 0 });

function TriageSessionUnlinkControl(props: Readonly<{
  sessionId: string;
  entryRef: TriageEntryRefV1;
  onUnlinked: () => void | Promise<void>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { spacing } = usePluginTheme();
  const { phase, unlink } = useTriageUnlinkLinkedEntry(props.onUnlinked);
  return (
    // Unlink removes the link, so it keeps a wider berth than the row's gap from Open session. The berth is
    // also what keeps their two hit areas apart under a finger: the Buttons reach 44 from their drawn 32 and
    // the public Button has no per-side reach to share a smaller gap with.
    <Stack gap="xsmall" style={{ marginLeft: spacing.small }}>
      <Button
        titleKey="plugins.triage.sessionLinks.unlink"
        title="Unlink"
        variant="plain"
        busy={phase === 'removing'}
        disabled={phase === 'removing'}
        onPress={() => { void unlink({ sessionId: props.sessionId, entryRef: props.entryRef }); }}
      />
      {phase === 'failed' ? <Status tone="warning" label={text('plugins.triage.sessionLinks.unlinkFailed', 'This link could not be removed.')} /> : null}
    </Stack>
  );
}

/**
 * The entry's linked investigation, live (plan 05 §4.6): the real Session — transcript, prompts
 * and composer — rendered by Happier through `SessionChat`, with one explicit way to open it in
 * full. Mounted details use the shell's surface-local selection and Action callback. The local
 * fallback serves standalone presentation only; no mounted detail uses it.
 */
export function TriageSessionPanel(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  entryRef: TriageEntryRefV1;
  onUnlinked: () => void | Promise<void>;
  selectedSessionId?: TriageLinkedSessionProjectionV1['sessionId'] | null;
  onSelectSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  /**
   * `pane`: mounted under the pane header the host draws (the page's companion). The Session's name and its
   * actions go in that header; the body is the Session itself.
   */
  header?: 'pane';
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { spacing } = usePluginTheme();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const opener = useLinkedSessionOpen();
  // The first linked Session (projection order) until the person picks another; a pick that
  // leaves the projection falls back to the first rather than to nothing.
  const selected = props.sessions.find((session) => session.sessionId === (props.selectedSessionId ?? selectedId)) ?? props.sessions[0];
  // The Agent mark comes only from the host's canonical Session projection: its admitted
  // `agent.brand` is the exact BrandMark target. Without it the title stays unmarked; the
  // Session title or any default never stands in for an Agent.
  const sessionStates = useSessionStates(props.sessions.map((session) => session.sessionId)).sessions;
  const agentBrandPluginId = sessionStates.get(selected?.sessionId ?? '')?.state?.agent?.brand?.pluginId;
  if (selected === undefined) return null;
  const titleOf = (session: TriageLinkedSessionProjectionV1) => (
    readTriageSessionTitle(sessionStates.get(session.sessionId), text)
  );
  const name = titleOf(selected);
  const pickerLabel = text('plugins.triage.surface.detail.session.picker', 'Linked session');
  // Quiet actions beside the name: the switch only when there is more than one Session to switch to.
  const actions = (
    <Row gap="xsmall" align="center">
      {props.sessions.length > 1 ? (
        <Dropdown
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          trigger={name}
          triggerAppearance="text"
          triggerIcon="conversations"
          triggerAccessibilityLabel={`${pickerLabel}: ${name}`}
          items={props.sessions.map((session) => ({
            id: session.sessionId,
            label: titleOf(session),
            kind: 'radio' as const,
            radioGroupId: 'linked-session',
          }))}
          radioGroups={[{ id: 'linked-session', accessibilityLabel: pickerLabel, selectedId: selected.sessionId }]}
          onSelect={(sessionId) => {
            if (props.onSelectSession === undefined) setSelectedId(sessionId);
            else props.onSelectSession(sessionId);
            setPickerOpen(false);
          }}
        />
      ) : null}
      <IconButton
        icon={<Icon name="external" tone="secondary" />}
        accessibilityLabel={text('plugins.triage.surface.detail.session.open', 'Open session')}
        busy={opener.busySessionId !== null}
        onPress={() => { void opener.open(selected.sessionId); }}
      />
      <TriageSessionUnlinkControl key={selected.sessionId} sessionId={selected.sessionId}
        entryRef={props.entryRef} onUnlinked={props.onUnlinked} />
    </Row>
  );
  return (
    <Stack style={FILL_STYLE}>
      {props.header === 'pane' ? <PaneHeaderContent line={[name]} actions={actions} /> : (
        <Row gap="small" align="center" style={{ paddingVertical: spacing.small }}>
          {agentBrandPluginId === undefined ? null : <BrandMark pluginId={agentBrandPluginId} size="small" />}
          <Stack style={FILL_STYLE}>
            <Text variant="label" value={name} numberOfLines={1} />
          </Stack>
          {actions}
        </Row>
      )}
      {opener.failedSessionId !== selected.sessionId ? null : (
        <Status tone="danger" labelKey="plugins.triage.surface.detail.sessionOpenFailed"
          label="This Session could not be opened." />
      )}
      <Stack style={FILL_STYLE}>
        <SessionChat
          // One provider per Session: switching the selection replaces the controller.
          key={selected.sessionId}
          sessionId={selected.sessionId}
          testID="triage-detail-session"
          fallback={(
            <EmptyState
              titleKey="plugins.triage.surface.detail.session.unavailableHere"
              title="Open this session in Happier to follow it live."
            />
          )}
        />
      </Stack>
    </Stack>
  );
}

/**
 * A source that declares no tabs keeps its whole detail; with a linked Session the body gains
 * Overview | Session above it (plan 05 §4.6; lab t1), and without one it is exactly the source's detail.
 */
export function TriageDetailWholeBody(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  entryRef: TriageEntryRefV1;
  onUnlinked: () => void | Promise<void>;
  tabSelection?: TriageDetailTabSelectionV1;
  pushed?: boolean;
  selectedSessionId?: TriageLinkedSessionProjectionV1['sessionId'] | null;
  onSelectSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  children: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [selected, setSelected] = React.useState<'details' | 'session'>('details');
  const value = props.tabSelection === undefined ? selected : props.tabSelection.value === 'session' ? 'session' : 'details';
  const tabs = useTriageDetailAvailableTabs([
    { value: 'details', title: text('plugins.triage.surface.detail.tab.overview', 'Overview') },
    ...(props.sessions.length === 0 ? [] : [{ value: 'session', title: text('plugins.triage.surface.detail.tab.session', 'Session') }]),
  ], props.tabSelection?.onAvailableTabsChange);
  return (
    <Tabs
      presentation="page"
      pageKind={TRIAGE_DETAIL_PAGE_KIND_V1}
      phonePresented={props.pushed}
      value={value}
      onValueChange={(value) => {
        setSelected(value === 'session' ? 'session' : 'details');
        props.tabSelection?.onChange(value);
      }}
      ariaLabel={text('plugins.triage.surface.detail.tabs', 'Entry detail')}
      // The Session tab hosts the live chat, which needs the detail's remaining height.
      layout="fill"
    >
      <Tabs.Item value="details" title={tabs[0]!.title} glyph="info" retention="retain">
        {props.children}
      </Tabs.Item>
      {props.sessions.length === 0 ? null : <Tabs.Item value="session" title={tabs[1]!.title} glyph="conversations" retention="discard"
        kind="both" companion={TRIAGE_ENTRY_SESSION_COMPANION_V1}>
        <TriageSessionPanel sessions={props.sessions} entryRef={props.entryRef} onUnlinked={props.onUnlinked}
          selectedSessionId={props.selectedSessionId} onSelectSession={props.onSelectSession} />
      </Tabs.Item>}
    </Tabs>
  );
}
