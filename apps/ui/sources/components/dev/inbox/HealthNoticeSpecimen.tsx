import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { TriageSessionHandoffSelectionV1 } from '@happier-dev/triage-protocol/v1';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { InboxNoticeDetail } from '@/components/inbox/detail/InboxItemDetail';
import type { BoundHealthNoticeInvestigation } from '@/components/inbox/detail/healthNoticeInvestigation';

/**
 * Dev-only specimen of a failing-service Inbox notice (lab publish/s4 `detail`) drawn by the real notice page
 * over a fixture Triage boundary. `?outcome=` picks what the configured handoff answers after Investigate
 * (`approval|placement|selection|uncertain|unavailable`; default answers like an opened draft). `?recovered=1` shows
 * the healthy-again notice. `?kind=sentry` draws a provider alert (an open Sentry issue) instead, and
 * `?eligible=0` an alert whose stored evidence cannot start an investigation. It proves composition
 * only; the loaded notice is judged on real health data.
 */
const SELECTION: TriageSessionHandoffSelectionV1 = {
  configuredActionId: 'investigate', sessionChoice: { kind: 'configured' },
  agentChoice: { kind: 'configured' }, delivery: 'configured',
};
const HANDOFFS: Record<string, ActionExecuteResult> = {
  approval: { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-specimen', actionId: 'action.invoke' } },
  selection: { ok: true, result: { v: 1, handoff: { kind: 'selectionRequired', fields: ['agentChoice'] } } },
  uncertain: { ok: true, result: { v: 1, handoff: { kind: 'uncertain', phase: 'create', session: null } } },
  unavailable: { ok: true, result: { v: 1, handoff: { kind: 'unavailable', reason: 'targetUnavailable' } } },
  notSetUp: { ok: true, result: { v: 1, handoff: { kind: 'unavailable', reason: 'configuredActionUnavailable' } } },
};
const OPENED: ActionExecuteResult = { ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } };
function placementChoice(machineId: string): ActionExecuteResult {
  const folder = (rootPath: string, workspaceId: string) => ({ serverId: 'specimen', workspaceId, machineId, rootPath });
  return { ok: true, result: { v: 1, handoff: { kind: 'placement_choice_required', reason: 'ambiguous_workspace', candidates: [
    { machine: { serverId: 'specimen', machineId }, workspace: folder('~/srv/checkout-api', 'ws-checkout'), reachable: true },
    { machine: { serverId: 'specimen', machineId }, workspace: folder('~/srv/checkout-api-staging', 'ws-staging'), reachable: true },
    { machine: { serverId: 'specimen', machineId: 'specimen-offline' }, reachable: false },
  ], agents: [
    { targetKey: 'agent:happier.agent.claude/claude', label: 'Claude Code' },
    { targetKey: 'agent:happier.agent.codex/codex', label: 'Codex' },
  ] } } };
}
const CREATED_AT = Date.now() - 12 * 60_000;
const dismiss = async () => {};

export function HealthNoticeSpecimen(props: Readonly<{ outcome: string; recovered: boolean; machineId: string;
  kind?: 'service' | 'sentry'; eligible?: boolean }>) {
  const investigation = React.useMemo<BoundHealthNoticeInvestigation>(() => ({
    readChoices: async () => ({ v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [{ label: 'Investigate', selection: SELECTION }] }),
    resume: () => null,
    run: async (_selection, options) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      // A placement choice answers once; the chosen Machine and folder open the draft.
      if (props.outcome === 'placement') return options.placement ? OPENED : placementChoice(props.machineId);
      return HANDOFFS[props.outcome] ?? OPENED;
    },
  }), [props.outcome, props.machineId]);
  const serverId = useActiveServerAccountScope()?.serverId ?? '';
  const open = !props.recovered;
  const investigable = open && props.eligible !== false;
  if (props.kind === 'sentry') return (
    <InboxNoticeDetail
      title="TypeError: Invalid pool size NaN"
      body={open ? 'New issue in Sentry.\nhttps://acme.sentry.io/issues/4821936/' : 'Resolved in Sentry.\nhttps://acme.sentry.io/issues/4821936/'}
      source="Sentry"
      createdAt={CREATED_AT}
      onDismiss={dismiss}
      serverId={serverId}
      subject={{ kind: 'alert', open, investigable }}
      investigation={investigable ? investigation : null}
    />
  );
  return (
    <InboxNoticeDetail
      title={props.recovered ? 'checkout-api is healthy again' : 'checkout-api is failing its health check'}
      body={props.recovered
        ? 'Staging on this Machine was down for 29 minutes and its health check passes again.'
        : 'Docker’s health check for checkout-api has failed since 11:02.'}
      source="Service health"
      createdAt={CREATED_AT}
      onDismiss={dismiss}
      serverId={serverId}
      subject={{ kind: 'service', machineId: props.machineId, service: 'checkout-api', open, investigable }}
      investigation={investigable ? investigation : null}
    />
  );
}
