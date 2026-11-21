import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import type { ActionApprovalScopeV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { SessionApprovalConsentModeChangeV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import {
  ApprovalSessionConsentRow,
  useApprovalSessionConsentChoiceState,
  type ApprovalSessionConsentChoice,
} from './ApprovalSessionConsentChoice';

type Write = (
  change: SessionApprovalConsentModeChangeV1,
) => Promise<Readonly<{ ok: boolean }>>;

/** The consent owner's writer is the Action-execution boundary; record what it is asked to save. */
function recordingWriter(
  result: Readonly<{ ok: boolean }> | Error = { ok: true },
) {
  const writes: SessionApprovalConsentModeChangeV1[] = [];
  const write: Write = async (change) => {
    writes.push(change);
    if (result instanceof Error) throw result;
    return result;
  };
  return { writes, write };
}

let latest: ApprovalSessionConsentChoice | null = null;

function Sheet(
  props: Readonly<{
    write: Write;
    open?: boolean;
    actionId?: string | null;
    scope?: ActionApprovalScopeV1 | null;
  }>,
) {
  const actionId =
    props.actionId === undefined ? 'deployments.deploy' : props.actionId;
  const choice = useApprovalSessionConsentChoiceState({
    requestKey: 'request-1',
    actionId,
    address: { serverId: 'home-1', sessionId: 'session-1' },
    scope: props.scope ?? null,
    offered: actionId !== null,
    setRow: props.write,
    ready: true,
  });
  latest = choice;
  return (
    <ApprovalSessionConsentRow
      choice={choice}
      open={props.open ?? true}
      agentLabel="Claude"
      actionTitle="Deploy"
    />
  );
}

async function approve() {
  await act(async () => {
    await latest?.saveAfterApproved();
  });
}

describe('Next time in this Session', () => {
  afterEach(async () => {
    latest = null;
    await standardCleanup();
  });

  it('saves nothing when the person keeps Ask again', async () => {
    const { writes, write } = recordingWriter();
    const screen = await renderScreen(<Sheet write={write} />);
    expect(
      screen.findByTestId('approvals.session-consent:ask')?.props
        .accessibilityState.checked,
    ).toBe(true);
    expect(screen.getTextContent()).toContain('Claude asks again next time.');
    await approve();
    expect(writes).toEqual([]);
  });

  it('saves Always for this Action in this Session, with no second confirmation', async () => {
    const { writes, write } = recordingWriter();
    const screen = await renderScreen(<Sheet write={write} />);
    // Only Ask again and Always while the request names no admitted Machine.
    expect(screen.findByTestId('approvals.session-consent:scoped')).toBeNull();
    await screen.pressByTestIdAsync('approvals.session-consent:always');
    expect(screen.getTextContent()).toContain(
      'Claude can run Deploy in this Session without asking. Change it in Session › Allowed.',
    );
    await approve();
    expect(writes).toEqual([
      { actionId: 'deployments.deploy', audience: 'agent', mode: 'allowed' },
    ]);
    expect(screen.findByTestId('approvals.session-consent-failed')).toBeNull();
  });

  it('offers and saves the Machine rung when admission scoped the request', async () => {
    const { writes, write } = recordingWriter();
    const scope = { kind: 'machine', machineId: 'machine-7' } as const;
    const screen = await renderScreen(<Sheet write={write} scope={scope} />);
    await screen.pressByTestIdAsync('approvals.session-consent:scoped');
    expect(screen.getTextContent()).toContain('On machine-7');
    await approve();
    expect(writes).toEqual([
      {
        actionId: 'deployments.deploy',
        audience: 'agent',
        scope,
        mode: 'allowed',
      },
    ]);
  });

  it.each([
    ['refused', { ok: false }],
    ['thrown', new Error('offline')],
  ] as const)(
    'keeps approving once and says so when the save is %s',
    async (_label, result) => {
      const { write } = recordingWriter(result);
      const screen = await renderScreen(<Sheet write={write} />);
      await screen.pressByTestIdAsync('approvals.session-consent:always');
      await approve();
      // The request settles; the choice leaves and the failure line stays.
      await screen.update(<Sheet write={write} open={false} />);
      expect(screen.findByTestId('approvals.session-consent')).toBeNull();
      expect(screen.getTextContent()).toContain(
        'Approved once. Couldn’t save it for this Session; you’ll be asked again.',
      );
    },
  );

  it('offers no row for an Action a Session row cannot change', async () => {
    const { write } = recordingWriter();
    const screen = await renderScreen(<Sheet write={write} actionId={null} />);
    expect(screen.findByTestId('approvals.session-consent')).toBeNull();
  });
});
