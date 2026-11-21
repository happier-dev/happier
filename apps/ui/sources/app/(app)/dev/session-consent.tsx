import * as React from 'react';

import {
  ApprovalSessionConsentRow,
  useApprovalSessionConsentChoiceState,
} from '@/components/approvals/ApprovalSessionConsentChoice';
import { SessionAllowedActionsGroup } from '@/components/sessions/permissions/SessionAllowedActionsSection';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

/**
 * Dev-only: "allow for this Session" in the states a person reaches, drawn by the real owners with static data
 * (no RPCs): the approval sheet's "Next time in this Session" row (Ask again, Always, the Machine rung, a failed
 * save) and Session › Allowed's Actions section (rows, empty, loading, unavailable).
 */
const ADDRESS = { serverId: 'dev-home', sessionId: 'dev-session' } as const;
const SAVED = async () => ({ ok: true });
const REFUSED = async () => ({ ok: false });
const ROWS = Object.freeze([
  { actionId: 'deployments.deploy', audience: 'agent', mode: 'allowed' },
  {
    actionId: 'projects.compute.exec',
    audience: 'agent',
    scope: { kind: 'machine', machineId: 'studio-mac' },
    mode: 'allowed',
  },
  { actionId: 'session.spawn_new', audience: 'agent', mode: 'ask_first' },
] as const);
const STATES = [
  { key: 'rows', state: { status: 'ready', rows: ROWS } },
  { key: 'empty', state: { status: 'ready', rows: [] } },
  { key: 'loading', state: { status: 'loading' } },
  { key: 'unavailable', state: { status: 'unavailable' } },
] as const;

function SheetRow(props: Readonly<{ scoped?: boolean; failed?: boolean }>) {
  const choice = useApprovalSessionConsentChoiceState({
    requestKey: 'dev',
    actionId: 'deployments.deploy',
    address: ADDRESS,
    scope: props.scoped ? { kind: 'machine', machineId: 'studio-mac' } : null,
    offered: true,
    setRow: props.failed ? REFUSED : SAVED,
    ready: true,
  });
  const { choose, saveBeforeApprove } = choice;
  React.useEffect(() => {
    if (props.failed) {
      choose('always');
    }
  }, [choose, props.failed]);
  React.useEffect(() => {
    if (props.failed && choice.value === 'always') void saveBeforeApprove();
  }, [choice.value, props.failed, saveBeforeApprove]);
  return (
    <ApprovalSessionConsentRow
      choice={choice}
      open={!props.failed || !choice.saveFailed}
      agentLabel="Claude"
      actionTitle="Deploy environment"
    />
  );
}

export default function SessionConsentDevScreen() {
  const state = STATES.find((entry) => entry.key === 'rows')!;
  return (
    <ItemList>
      <PageHeader
        title={t('sessionRemotePermissionGrants.title')}
        description={t('sessionPages.permissions.description')}
      />
      <SheetRow />
      <SheetRow scoped />
      <SheetRow failed />
      <SessionAllowedActionsGroup
        serverId={ADDRESS.serverId}
        state={state.state}
        setRow={SAVED}
            catalog={null}
        ready
      />
      {STATES.filter((entry) => entry.key !== 'rows').map((entry) => (
        <SessionAllowedActionsGroup
          key={entry.key}
          serverId={ADDRESS.serverId}
          state={entry.state}
          setRow={SAVED}
            catalog={null}
          ready
        />
      ))}
    </ItemList>
  );
}
