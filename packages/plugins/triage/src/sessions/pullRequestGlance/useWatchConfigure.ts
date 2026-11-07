import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { ProtocolActionApprovalRequestCreatedResultSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
  SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1,
  SessionPullRequestBindingInputV1Schema,
  SessionPullRequestBindingResultV1Schema,
  SessionPullRequestWatchInputV1Schema,
  SessionPullRequestWatchResultV1Schema,
  type SessionPullRequestWatchPolicyV1,
} from '@happier-dev/channels-protocol/v1';

import type { TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';

export type PullRequestWatchConfigureStateV1 =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending'; bindingId: string }>
  | Readonly<{ kind: 'approval'; bindingId: string }>
  | Readonly<{ kind: 'failed'; bindingId: string }>;

const IDLE: PullRequestWatchConfigureStateV1 = Object.freeze({ kind: 'idle' });
const WATCH: PluginContributionRef = {
  pluginId: 'happier.channels',
  localId: SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1,
};
const BINDING: PluginContributionRef = {
  pluginId: 'happier.channels',
  localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
};

/**
 * A person's watch edits through Channels' own Actions, at the binding revision the glance shows: the mode
 * (Watch `configure`) and Unlink (binding `unlink`). The viewer's mounted host keeps their authority and each
 * Action's confirmation policy; a stale revision is refused by the owner, never retried here. The Resource stays
 * the one source of what is shown.
 */
export function usePullRequestWatchConfigureV1(
  sessionId: string | null,
  refresh: () => Promise<unknown>,
) {
  const host = usePluginHostApi();
  const [state, setState] =
    React.useState<PullRequestWatchConfigureStateV1>(IDLE);
  const run = React.useCallback(
    async (
      bindingId: string,
      action: PluginContributionRef,
      input: JsonValue,
      settled: (result: unknown) => boolean,
    ) => {
      setState({ kind: 'pending', bindingId });
      try {
        const result = await host.executeAction(action, input);
        if (
          ProtocolActionApprovalRequestCreatedResultSchema.safeParse(result)
            .success
        ) {
          setState({ kind: 'approval', bindingId });
          return;
        }
        if (!settled(result)) {
          setState({ kind: 'failed', bindingId });
          return;
        }
        await refresh();
        setState(IDLE);
      } catch {
        setState({ kind: 'failed', bindingId });
      }
    },
    [host, refresh],
  );
  const configure = React.useCallback(
    async (
      binding: TriageSessionPullRequestBindingV1,
      policy: SessionPullRequestWatchPolicyV1,
    ) => {
      if (sessionId === null) return;
      const input = SessionPullRequestWatchInputV1Schema.parse({
        kind: 'configure',
        sessionId,
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        policy,
      });
      await run(binding.bindingId, WATCH, input, (result) => {
        const parsed = SessionPullRequestWatchResultV1Schema.safeParse(result);
        return parsed.success && parsed.data.kind === 'updated';
      });
    },
    [run, sessionId],
  );
  /** Continue fixing after the fix limit: Watch `retryFix` grants the Account's effective N to the same sequence. */
  const continueFixing = React.useCallback(async (binding: TriageSessionPullRequestBindingV1) => {
    if (sessionId === null) return;
    const input = SessionPullRequestWatchInputV1Schema.parse({ kind: 'retryFix', sessionId,
      bindingId: binding.bindingId, expectedRevision: binding.revision });
    await run(binding.bindingId, WATCH, input, (result) => {
      const parsed = SessionPullRequestWatchResultV1Schema.safeParse(result);
      return parsed.success && parsed.data.kind === 'updated';
    });
  }, [run, sessionId]);
  const unlink = React.useCallback(
    async (binding: TriageSessionPullRequestBindingV1) => {
      if (sessionId === null) return;
      const input = SessionPullRequestBindingInputV1Schema.parse({
        kind: 'unlink',
        sessionId,
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
      });
      await run(binding.bindingId, BINDING, input, (result) => {
        const parsed =
          SessionPullRequestBindingResultV1Schema.safeParse(result);
        return parsed.success && parsed.data.kind === 'removed';
      });
    },
    [run, sessionId],
  );
  const dismiss = React.useCallback(() => setState(IDLE), []);
  return React.useMemo(
    () => ({ state, configure, continueFixing, unlink, dismiss }),
    [configure, continueFixing, dismiss, state, unlink],
  );
}
