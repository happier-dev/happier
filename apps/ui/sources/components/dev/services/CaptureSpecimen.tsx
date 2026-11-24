import * as React from 'react';
import { ScrollView } from 'react-native';

import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import {
  ListPresentationProvider,
  PageColumnProvider,
} from '@/components/ui/lists/listPresentation';
import {
  LocalServiceCaptureView,
  type LocalServiceCaptureViewId,
} from '@/components/sessions/localServices/LocalServiceCaptureView';
import type { TelemetryCaptureInvoke } from '@/components/projects/deployments/telemetryCaptureReads';
import {
  TelemetryCaptureFixtureProvider,
  createTelemetryCaptureFixtureInvoke,
  createTelemetryCaptureFixtureTransport,
} from '@/dev/testkit/fixtures/telemetryCaptureFixtures';

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
 * Dev-only: a worktree's capture view (Dev servers → Endpoints, Traces, Logs) in the states a live bed reaches only
 * by breaking it, drawn through the real `LocalServiceCaptureView` over the shared capture fixture.
 */
export function CaptureSpecimen(
  props: Readonly<{
    state: CaptureSpecimenState;
    view: LocalServiceCaptureViewId;
  }>,
) {
  const invoke = React.useMemo(
    () => specimenInvoke(props.state),
    [props.state],
  );
  const transport = React.useMemo(
    () => createTelemetryCaptureFixtureTransport(invoke),
    [invoke],
  );
  // A stale view is one that read once and then failed to refresh: ask it to refresh once it has its rows.
  React.useEffect(() => {
    if (props.state !== 'stale') return undefined;
    const timer = setTimeout(() => transport.invalidate(), 1_500);
    return () => clearTimeout(timer);
  }, [props.state, transport]);
  return (
    <ListPresentationProvider value="page">
      <PageColumnProvider value="dashboard">
        <ScrollView style={{ flex: 1 }}>
          <ConstrainedScreenContent>
            <TelemetryCaptureFixtureProvider
              invoke={invoke}
              transport={transport}
            >
              <LocalServiceCaptureView
                lifetime={LIFETIME}
                worktree={WORKTREE}
                view={props.view}
                active
                machineName="MacBook Pro"
                onShowServers={() => {}}
                testID="capture-specimen"
              />
            </TelemetryCaptureFixtureProvider>
          </ConstrainedScreenContent>
        </ScrollView>
      </PageColumnProvider>
    </ListPresentationProvider>
  );
}
