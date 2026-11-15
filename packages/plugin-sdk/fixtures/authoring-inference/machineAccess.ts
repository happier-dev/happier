import type { ActionsService, PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { createElement, useState } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { Button, ItemGroup, Text } from '@happier-dev/plugin-ui/components';

const target = { serverId: 'home', machineId: 'machine' };
const input = { ...target, principal: { kind: 'account', accountId: 'recipient' }, level: 'view' } satisfies PluginActionInputById['machines.access.grant.set'];

/** Only recipient readiness and content-free work totals cross this public surface. */
export const machineAccessSurface = defineUiSurface(({ hostApi }) => {
  const [recipient, setRecipient] = useState('unknown');
  const [work, setWork] = useState('unknown');
  return createElement(ItemGroup, { title: 'Machine access' },
    createElement(Button, { title: 'Read machine access', onPress: async () => {
      const access = await hostApi.executeAction('machines.access.grants.list', target);
      setRecipient('kind' in access ? access.code : access.access.accessState);
      const summary = await hostApi.executeAction('machines.work.summary.get', target);
      setWork(summary.kind === 'current' ? summary.requesters.map(requester =>
        `${requester.displayName}: ${requester.sessions} sessions, ${requester.tasks} tasks, ${requester.terminals} terminals`).join('; ')
        : summary.kind);
    } }),
    createElement(Text, { value: recipient }), createElement(Text, { value: work }));
});

export async function machineSharing(actions: ActionsService) {
  const result = await actions.execute('machines.access.grants.list', target);
  if (isPluginActionApprovalRequestCreated(result)) return;
  const access: PluginActionResultById['machines.access.grants.list'] = result;
  if (!('kind' in access)) {
    const status: 'ready' | 'key_pending' | 'refused' = access.access.accessState;
    void status;
  }
  await actions.execute('machines.access.grant.set', input);
  await actions.execute('machines.access.leave', target);
  await actions.execute('machines.access.prepareKeys', target);
  const terminal = { ...target, terminalKey: 'member', workspace: {
    ...target, workspaceId: 'accepted', rootPath: '/repo',
  } } satisfies PluginActionInputById['machines.terminal.open'];
  await actions.execute('machines.terminal.open', terminal);
  await actions.execute('machines.terminal.list', target);
  await actions.execute('machines.terminal.restart', terminal);
  await actions.execute('machines.terminal.read', { ...target, terminalId: 'pty', byteOffset: 0 });
  await actions.execute('machines.terminal.write', { ...target, terminalId: 'pty', event: { t: 'text', text: 'pwd\r' } });
  await actions.execute('machines.terminal.close', { ...target, terminalId: 'pty' });
  const summary = await actions.execute('machines.work.summary.get', target);
  if (!isPluginActionApprovalRequestCreated(summary) && summary.kind === 'current') {
    for (const requester of summary.requesters) {
      // @ts-expect-error Manage exposes counts, never another person's Session identity.
      requester.sessionId;
      // @ts-expect-error Private runtime bindings are not part of safe work summaries.
      requester.runtimeBinding;
    }
  }
  // @ts-expect-error The host owns requester runtime credentials and bindings.
  await actions.execute('machines.terminal.open', { ...terminal, runtimeBinding: { accountId: 'foreign', token: 'private' } });
  // @ts-expect-error Machine Manage cannot bind a work-summary read to a foreign Session.
  await actions.execute('machines.work.summary.get', { ...target, sessionId: 'foreign-session' });
  // @ts-expect-error Requester custody is stamped by the trusted host, not an author.
  await actions.execute('machines.terminal.open', {
    ...terminal,
    requesterAccountId: 'forged',
  });
  // @ts-expect-error Public grants cannot accept physical recipient ciphertext.
  await actions.execute('machines.access.grant.set', {
    ...input,
    recipientKeyEnvelopes: [],
  });
  // @ts-expect-error An author cannot supply an admission or grant proof.
  await actions.execute('machines.access.grants.list', {
    ...target,
    admission: { role: 'manage' },
  });
}
