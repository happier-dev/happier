import * as React from 'react';

import { DetectedLocalServicesPane } from '@/components/sessions/localServices/DetectedLocalServicesPane';
import {
  LocalServiceCaptureView,
  type LocalServiceCaptureViewId,
} from '@/components/sessions/localServices/LocalServiceCaptureView';
import type { TelemetryCaptureInvoke } from '@/components/projects/deployments/telemetryCaptureReads';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import {
  TelemetryCaptureFixtureProvider,
  createTelemetryCaptureFixtureInvoke,
  createTelemetryCaptureFixtureTransport,
} from '@/dev/testkit/fixtures/telemetryCaptureFixtures';
import { createLocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import { t } from '@/text';

/** The capture states a live bed rarely reaches on demand. */
export type CaptureSpecimenState =
  | 'unavailable'
  | 'stale'
  | 'restart'
  | 'approval';

const LIFETIME = {
  scope: { serverId: 'home-specimen', accountId: 'owner-specimen' },
  isCurrent: () => true,
  onRetire: () => ({ dispose() {} }),
};
const WORKTREE = {
  machineId: 'machine-specimen',
  projectId: 'billing-api',
  workspaceId: 'checkout-main',
};
const INVENTORY = createLocalServiceInventoryState();
const MACHINE = { name: 'MacBook Pro', homeDir: '/Users/me', reachability: 'reachable' as const };
const unavailable = () =>
  Object.assign(new Error('telemetry_unavailable'), {
    code: 'telemetry_unavailable',
  });

/**
 * One state's collector over the shared capture fixture: `unavailable` answers its status but not its list;
 * `stale` answers each list once, then stops (the retained rows stay under the line); `restart` says the running
 * dev servers still hold the old binding; `approval` is off, and Turn on waits for the person's approval.
 */
function specimenInvoke(state: CaptureSpecimenState): TelemetryCaptureInvoke {
  const populated = createTelemetryCaptureFixtureInvoke('populated');
  const answered = new Set<string>();
  let enabled = state !== 'approval';
  return async (call) => {
    const { actionId, input } = call;
    const source = (input as { source?: unknown }).source;
    if (actionId.endsWith('/capture/configure')) {
      if (state === 'approval') {
        return {
          kind: 'approval_request_created',
          artifactId: 'approval-capture-specimen',
          actionId,
        };
      }
      enabled = (input as { enabled: boolean }).enabled;
      return { ok: true, enabled };
    }
    if (actionId.endsWith('/capture/status')) {
      return {
        ok: true,
        source,
        coverage: { lostObservations: 0, reason: null },
        enabled,
        ...(state === 'restart' ? { restartRequired: true as const } : {}),
      };
    }
    if (actionId.endsWith('/list')) {
      if (state === 'unavailable') throw unavailable();
      if (state === 'stale') {
        if (answered.has(actionId)) throw unavailable();
        answered.add(actionId);
      }
    }
    return populated(call);
  };
}

/**
 * Dev-only: Dev servers with a capture view open, in the states a live bed reaches only by breaking it. The real page
 * composition (`DetectedLocalServicesPane` as a page: its title, view tabs and column) hosts the real
 * `LocalServiceCaptureView` over the shared capture fixture, so a state is judged where it stands on the page.
 */
export function CaptureSpecimen(props: Readonly<{ state: CaptureSpecimenState; view: LocalServiceCaptureViewId }>) {
  const invoke = React.useMemo(() => specimenInvoke(props.state), [props.state]);
  const transport = React.useMemo(() => createTelemetryCaptureFixtureTransport(invoke), [invoke]);
  const [view, setView] = React.useState<LocalServiceCaptureViewId>(props.view);
  // A stale view is one that read once and then failed to refresh: ask it to refresh once it has its rows.
  React.useEffect(() => {
    if (props.state !== 'stale') return undefined;
    const timer = setTimeout(() => transport.invalidate(), 1_500);
    return () => clearTimeout(timer);
  }, [props.state, transport]);
  const viewTabs = (
    <SegmentedTabBar<'servers' | LocalServiceCaptureViewId>
      accessibilityLabel={t('deploymentTelemetry.local.views')}
      testIDPrefix="capture-specimen-view"
      segmentSizing="content"
      activeTabId={view}
      tabs={[
        { id: 'servers', label: t('deploymentTelemetry.local.servers') },
        { id: 'endpoints', label: t('deploymentTelemetry.tabs.endpoints') },
        { id: 'traces', label: t('deploymentTelemetry.tabs.traces') },
        { id: 'logs', label: t('deploymentTelemetry.tabs.logs') },
      ]}
      onSelectTab={(id) => {
        if (id !== 'servers') setView(id);
      }}
    />
  );
  return (
    <ListPresentationProvider value="page">
      <TelemetryCaptureFixtureProvider invoke={invoke} transport={transport}>
        <DetectedLocalServicesPane
          presentation="page"
          inventoryState={INVENTORY}
          machine={MACHINE}
          viewTabs={viewTabs}
          viewBody={
            <LocalServiceCaptureView
              lifetime={LIFETIME}
              worktree={WORKTREE}
              view={view}
              active
              machineName={MACHINE.name}
              onShowServers={() => {}}
              testID="capture-specimen"
            />
          }
          testID="capture-specimen-page"
        />
      </TelemetryCaptureFixtureProvider>
    </ListPresentationProvider>
  );
}
