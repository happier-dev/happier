import * as React from 'react';

import {
  BrandMark,
  Button,
  Dropdown,
  EmptyState,
  Row,
  SessionChat,
  Stack,
  Status,
  Tabs,
  Text,
  usePluginTranslation,
  useSessionState,
} from '@happier-dev/plugin-ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import { useLinkedSessionOpen } from './useLinkedSessionOpen.js';
import type { TriageDetailTabSelectionV1 } from './body.js';

const FILL_STYLE = Object.freeze({ flex: 1, minWidth: 0, minHeight: 0 });
const TOOLBAR_STYLE = Object.freeze({ paddingHorizontal: 16, paddingVertical: 8, minHeight: 44 });

/**
 * The entry's linked investigation, live (plan 05 §4.6): the real Session — transcript, prompts
 * and composer — rendered by Happier through `SessionChat`, with one explicit way to open it in
 * full. Mounted details use the shell's surface-local selection and Action callback. The local
 * fallback serves standalone presentation only; no mounted detail uses it.
 */
export function TriageSessionPanel(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  selectedSessionId?: TriageLinkedSessionProjectionV1['sessionId'] | null;
  onSelectSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const opener = useLinkedSessionOpen();
  // The first linked Session (projection order) until the person picks another; a pick that
  // leaves the projection falls back to the first rather than to nothing.
  const selected = props.sessions.find((session) => session.sessionId === (props.selectedSessionId ?? selectedId)) ?? props.sessions[0];
  // The Agent mark comes only from the host's canonical Session projection: its admitted
  // `agent.brand` is the exact BrandMark target. Without it the title stays unmarked; the
  // Session title or any default never stands in for an Agent.
  const agentBrandPluginId = useSessionState(selected?.sessionId ?? null).state?.agent?.brand?.pluginId;
  if (selected === undefined) return null;
  const titleOf = (session: TriageLinkedSessionProjectionV1) => (
    session.displayTitle ?? text('plugins.triage.surface.detail.session', 'Session')
  );
  const pickerLabel = text('plugins.triage.surface.detail.session.picker', 'Linked session');
  return (
    <Stack style={FILL_STYLE}>
      <Row gap="small" align="center" style={TOOLBAR_STYLE}>
        {agentBrandPluginId === undefined ? null : <BrandMark pluginId={agentBrandPluginId} size="small" />}
        <Stack style={FILL_STYLE}>
          {props.sessions.length > 1 ? (
            <Dropdown
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              trigger={titleOf(selected)}
              triggerAppearance="control"
              triggerAccessibilityLabel={`${pickerLabel}: ${titleOf(selected)}`}
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
          ) : (
            <Text variant="label" value={titleOf(selected)} numberOfLines={1} />
          )}
        </Stack>
        <Button
          titleKey="plugins.triage.surface.detail.session.open"
          title="Open session"
          variant="secondary"
          busy={opener.busySessionId !== null}
          onPress={() => { void opener.open(selected.sessionId); }}
        />
      </Row>
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
 * Details | Session above it (plan 05 §4.6), and without one it is exactly the source's detail.
 */
export function TriageDetailWholeBody(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  tabSelection?: TriageDetailTabSelectionV1;
  selectedSessionId?: TriageLinkedSessionProjectionV1['sessionId'] | null;
  onSelectSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  children: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [selected, setSelected] = React.useState<'details' | 'session'>('details');
  const value = props.tabSelection === undefined ? selected : props.tabSelection.value === 'session' ? 'session' : 'details';
  const reportAvailableTabs = props.tabSelection?.onAvailableTabsChange;
  React.useLayoutEffect(() => {
    reportAvailableTabs?.(props.sessions.length === 0 ? [] : ['details', 'session']);
  }, [props.sessions.length, reportAvailableTabs]);
  if (props.sessions.length === 0) return <>{props.children}</>;
  return (
    <Tabs
      value={value}
      onValueChange={(value) => {
        setSelected(value === 'session' ? 'session' : 'details');
        props.tabSelection?.onChange(value);
      }}
      ariaLabel={text('plugins.triage.surface.detail.tabs', 'Entry detail')}
      // The Session tab hosts the live chat, which needs the detail's remaining height.
      layout="fill"
    >
      <Tabs.Item value="details" title={text('plugins.triage.surface.detail.tab.details', 'Details')} retention="retain">
        {props.children}
      </Tabs.Item>
      <Tabs.Item value="session" title={text('plugins.triage.surface.detail.tab.session', 'Session')} retention="retain">
        <TriageSessionPanel sessions={props.sessions} selectedSessionId={props.selectedSessionId} onSelectSession={props.onSelectSession} />
      </Tabs.Item>
    </Tabs>
  );
}
