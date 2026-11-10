import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { DocEditProposalV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import {
  createArtifactStoreBoundary,
  createPlainArtifactHttpFixture,
} from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

// Only the network, the device credential store and the native shell are replaced: the Action front door,
// the approval lifecycle, the Artifact store and the continuation observing it are the product's own.
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
const harness = createHomeGovernanceHarness();
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('react-native-gesture-handler', async () =>
  (
    await import('@/dev/testkit/mocks/gestureHandler')
  ).createGestureHandlerMock(),
);
vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock(),
);
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock('@/modal', async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module,
);
installHomeGovernanceBoundaries(harness);
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactEditProposal, announceAccepted } = await import('./ArtifactEditProposal');
const { admitDocEditOperation, docEditOperationKey, holdDocEditApproval, resetDocEditOperationsForTests } = await import('./docEditOperation');
const { readPresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');

const ACCOUNT_ID = 'account-a';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null =
  null;

const accepted = { headerVersion: 3, bodyVersion: 15 };
const base = { headerVersion: 3, bodyVersion: 14 };
const proposal: DocEditProposalV1 = {
  target: {
    ref: { kind: 'doc', serverId: 'home', artifactId: 'doc-1' },
    revision: base,
    range: { start: 0, end: 10 },
    quote: 'Two rows.!',
  },
  baseRevision: base,
  before: 'Two rows.!',
  after: 'One row.',
  reason: 'Replays are recorded once now.',
};
const proposalRef: DiscussionMessageRefV1 = {
  kind: 'discussion',
  discussion: { serverId: 'home', discussionId: 'd1' },
  messageId: 'm1',
};

/** The Home whose Account requires approval for restoring a version. */
async function addHome(approvalRequired = true): Promise<string> {
  const serverId = await harness.addHome({
    name: 'Home One',
    serverUrl: 'https://doc-edit-approval.example',
    accountId: ACCOUNT_ID,
  });
  const home = harness.findByServerUrl('https://doc-edit-approval.example');
  if (!home?.token) throw new Error('Expected the saved Home credential');
  for (const path of [
    '/v2/sessions/active',
    '/v2/sessions',
    '/v2/session-organization',
  ]) {
    harness.answer(serverId, `GET ${path}`, {
      select: async () => {
        const response = createEmptyAccountBootstrapHttpResponse(path);
        if (!response) throw new Error(`Missing bootstrap fixture: ${path}`);
        return { status: response.status, body: await response.json() };
      },
    });
  }
  harness.answer(serverId, '/v1/machines?includeRevoked=true', { body: [] });
  connection = await restoreServerAccountForTest({
    serverUrl: home.serverUrl,
    accountId: ACCOUNT_ID,
    credentials: { token: home.token },
    request: harness.request,
  });
  installHomeGovernanceBoundaries(harness);
  await harness.setActionPolicy(serverId, 'artifact.revisions.restore', 'ui', approvalRequired ? 'ask' : 'allowed');
  // The Doc at its accepted revision, one earlier version, and the restore that approval would run.
  const artifacts = createArtifactStoreBoundary({
    ownerAccountId: () => ACCOUNT_ID,
    encryptionMode: 'plain',
  });
  artifacts.replaceStoredRow(createPlainArtifactHttpFixture({
    id: 'doc-1',
    title: 'Runbook',
    isDecrypted: true,
    header: { kind: 'markdown', title: 'Runbook' },
    rawHeader: { kind: 'markdown', title: 'Runbook' },
    body: 'One row.',
    headerVersion: accepted.headerVersion,
    bodyVersion: accepted.bodyVersion,
    seq: 1,
    createdAt: 1,
    updatedAt: 2,
    access: 'owner',
    storageMode: 'plain',
  }, ACCOUNT_ID));
  harness.answer(serverId, 'GET /v1/artifacts/doc-1', {
    select: async () => {
      const response = await artifacts.handle('/v1/artifacts/doc-1', {
        method: 'GET',
        headers: new Headers(),
      });
      if (!response) throw new Error('Expected the Artifact store to serve the accepted Doc');
      return { status: response.status, body: await response.json() };
    },
  });
  harness.answer(serverId, 'GET /v1/artifacts/doc-1/revisions', {
    select: () => ({ body: {
      revisions: [
        ...(artifacts.read('doc-1')?.bodyVersion === 16 ? [{ bodyVersion: 16,
          body: artifacts.read('doc-1')!.body, provenance: artifacts.read('doc-1')!.provenance, createdAt: 6, sizeBytes: 10 }] : []),
        {
          bodyVersion: 14,
          body: encodePlainArtifactStoredContent({ body: 'Two rows.!' }),
          createdAt: 1,
          sizeBytes: 10,
        },
      ],
      retentionCount: 10,
    } }),
  });
  harness.answer(serverId, 'POST /v1/artifacts/doc-1/revisions/14/restore', {
    select: async (input) => {
      const write = input as { body: string; provenance?: string };
      const current = artifacts.read('doc-1');
      if (!current) throw new Error('Expected the accepted Doc before restoring it');
      artifacts.replaceStoredRow({ ...current, bodyVersion: 16, body: write.body, provenance: write.provenance });
      return { status: 200, body: { success: true, headerVersion: 3, bodyVersion: 16 } };
    },
  });
  return serverId;
}

async function mountReceipt(serverId: string, admission: 'standalone' | 'preadmitted' = 'standalone') {
  const client = createArtifactActionsClient({
    serverId,
    accountId: ACCOUNT_ID,
  });
  const admitted = admission === 'preadmitted'
    ? await client.readDoc({ ref: { kind: 'doc', serverId, artifactId: 'doc-1' } })
    : null;
  if (admitted && !admitted.ok) throw new Error(`Expected the accepted Doc read, received ${admitted.failure.code}`);
  const screen = await renderScreen(
    <ArtifactEditProposal
      testID="proposal"
      client={client}
      docRead={admitted ? { status: 'ready', value: admitted.value } : undefined}
      proposalRef={{
        ...proposalRef,
        discussion: { serverId, discussionId: 'd1' },
      }}
      proposal={proposal}
      viewerAccountId={ACCOUNT_ID}
      resolveAccountLabel={() => 'Ana'}
      disposition={{
        state: 'accepted',
        acceptedRevision: accepted,
        decidedBy: { accountId: ACCOUNT_ID, atMs: 5 },
      }}
    />,
  );
  if (admission === 'standalone') {
    // The canonical standalone Doc read admits the Artifact-store head before Undo appears.
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('proposal.undo')).not.toBeNull(),
    );
  }
  return screen;
}

const approvals = (serverId: string) =>
  harness
    .artifacts(serverId)
    .list()
    .filter((row) => row.id !== 'doc-1');

/** An explicit proposal creates an Inbox request; ordinary UI Ask is a native confirmation. */
async function requestProposalApproval(serverId: string, kind: 'undo' | 'accept' = 'undo') {
  const actionId = kind === 'undo' ? 'artifact.revisions.restore' : 'doc.edit.accept';
  const actionInput = kind === 'undo'
    ? { artifactId: 'doc-1', bodyVersion: base.bodyVersion, expectedRevision: accepted }
    : { proposalRef: { ...proposalRef, discussion: { serverId, discussionId: 'd1' } }, expectedRevision: base };
  const approvalId = await createUiApprovalRequest({ serverId, actionId, actionInput, actionRequestId: `proposal-${kind}` });
  // Resume the operation from the real request acknowledgement, as a retained surface does.
  await act(async () => {
    const key = docEditOperationKey({ serverId, accountId: ACCOUNT_ID }, proposalRef.messageId);
    expect(admitDocEditOperation(key, kind)).toBe(true);
    holdDocEditApproval(key, approvalId);
  });
  return approvalId;
}

describe('ArtifactEditProposal approval-gated operations', () => {
  beforeEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = null;
    await harness.reset();
    installDisconnectedServerSocketBoundary();
    navigation.push.mockClear();
    resetDocEditOperationsForTests();
  });
  afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = null;
  });

  it.each([false, true])('shares the compact notice Undo settlement with the current and reopened thread card (native confirmation: %s)', async approvalRequired => {
    const serverId = await addHome(approvalRequired);
    const scope = { serverId, accountId: ACCOUNT_ID };
    const client = createArtifactActionsClient(scope);
    const first = await mountReceipt(serverId);
    announceAccepted(client, 'doc-1', base.bodyVersion, accepted, docEditOperationKey(scope, proposalRef.messageId),
      (approvalId) => navigation.push(`approval:${approvalId}`));
    await act(async () => { readPresentationNotice()!.undo!.run(); });
    await waitForHomeGovernance(() => expect(readPresentationNotice()!.undo).toBeUndefined());
    expect(readPresentationNotice()!.severity).toBe('info');
    expect(approvals(serverId)).toHaveLength(0);
    expect(first.findByTestId('proposal.undone')).not.toBeNull();
    expect(first.findByTestId('proposal.undoConflict')).toBeNull();
    expect(first.findByTestId('proposal.undo')).toBeNull();
    await first.unmount();
    // A fresh Doc read now observes version 16 rather than the accepted version 15. That advance
    // came from this Undo; it must not become a conflicting edit when the thread is reopened.
    resetDocEditOperationsForTests(); // A full page load loses every process-local Undo acknowledgement.
    const second = await mountReceipt(serverId, 'preadmitted');
    await waitForHomeGovernance(() => expect(second.findByTestId('proposal.undone')).not.toBeNull());
    expect(second.getTextContent()).toContain('artifacts.browser.proposal.undone');
    expect(second.findByTestId('proposal.undoConflict')).toBeNull();
    expect(second.findByTestId('proposal.undo')).toBeNull();
    expect(harness.requestsFor('/v1/artifacts/doc-1/revisions/14/restore')).toHaveLength(1);
  });

  it('leaves Waiting for your approval when the request is executed: the receipt shows the restored version', async () => {
    const serverId = await addHome();
    const screen = await mountReceipt(serverId);
    await requestProposalApproval(serverId);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('proposal.undoPending')).not.toBeNull(),
    );
    expect(screen.findByTestId('proposal.undo')).toBeNull();
    await decideApprovalAsInbox(
      serverId,
      approvals(serverId)[0]!.id,
      'approve',
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('proposal.undone')).not.toBeNull(),
    );
    expect(screen.findByTestId('proposal.undoPending')).toBeNull();
    expect(
      harness.requestsFor('/v1/artifacts/doc-1/revisions/14/restore'),
    ).toHaveLength(1);
    await screen.unmount();
    const reopened = await mountReceipt(serverId, 'preadmitted');
    expect(reopened.findByTestId('proposal.undone')).not.toBeNull();
    expect(reopened.findByTestId('proposal.undoConflict')).toBeNull();
  });

  it('returns to the receipt, with Undo available again, when the request is rejected', async () => {
    const serverId = await addHome();
    const screen = await mountReceipt(serverId);
    await requestProposalApproval(serverId);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('proposal.undoPending')).not.toBeNull(),
    );
    await decideApprovalAsInbox(serverId, approvals(serverId)[0]!.id, 'reject');
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('proposal.undoPending')).toBeNull(),
    );
    expect(screen.findByTestId('proposal.undo')).not.toBeNull();
    expect(screen.findByTestId('proposal.undone')).toBeNull();
    expect(
      harness.requestsFor('/v1/artifacts/doc-1/revisions/14/restore'),
    ).toHaveLength(0);
  });

  it('returns to the receipt with its failure line when an approved restore fails', async () => {
    const serverId = await addHome();
    harness.answer(serverId, 'POST /v1/artifacts/doc-1/revisions/14/restore', {
      status: 500,
      body: { error: 'restore_failed' },
    });
    const screen = await mountReceipt(serverId);
    await requestProposalApproval(serverId);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('proposal.undoPending')).not.toBeNull(),
    );
    await decideApprovalAsInbox(serverId, approvals(serverId)[0]!.id, 'approve');
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('proposal.undoFailed')).not.toBeNull(),
    );
    expect(screen.findByTestId('proposal.accepted')).not.toBeNull();
    expect(screen.findByTestId('proposal.undoPending')).toBeNull();
    expect(screen.findByTestId('proposal.undo')).not.toBeNull();
    expect(
      harness.requestsFor('/v1/artifacts/doc-1/revisions/14/restore'),
    ).toHaveLength(1);
  });

  it('keeps one request across a remounted card and the compact notice Undo', async () => {
    const serverId = await addHome();
    const scope = { serverId, accountId: ACCOUNT_ID };
    const client = createArtifactActionsClient(scope);
    const first = await mountReceipt(serverId);
    await requestProposalApproval(serverId);
    // The compact notice and the card resume one admitted operation.
    announceAccepted(client, 'doc-1', base.bodyVersion, accepted, docEditOperationKey(scope, proposalRef.messageId),
      (approvalId) => navigation.push(`approval:${approvalId}`));
    await act(async () => { readPresentationNotice()!.undo!.run(); });
    await waitForHomeGovernance(() => expect(approvals(serverId)).toHaveLength(1));
    // ...so the card has no second Undo to press, also after Back remounts it.
    await waitForHomeGovernance(() => expect(first.findByTestId('proposal.undoPending')).not.toBeNull());
    expect(first.findByTestId('proposal.undo')).toBeNull();
    await first.unmount();
    // Back remounts with the same canonical doc.read fact already admitted; the held operation,
    // not unknown currentness, is therefore what keeps the second Undo absent.
    const second = await mountReceipt(serverId, 'preadmitted');
    await waitForHomeGovernance(() => expect(second.findByTestId('proposal.undoPending')).not.toBeNull());
    expect(second.findByTestId('proposal.undo')).toBeNull();
    // Pressing the notice again leads to the waiting request instead of creating another.
    navigation.push.mockClear();
    await act(async () => { readPresentationNotice()!.undo!.run(); });
    expect(approvals(serverId)).toHaveLength(1);
    expect(navigation.push).toHaveBeenCalledWith(`approval:${approvals(serverId)[0]!.id}`);
  });

  it('holds one request for a gated Accept, also after Back, and offers Accept again once it is rejected', async () => {
    const serverId = await addHome();
    await harness.requireUiApproval(serverId, 'doc.edit.accept');
    const client = createArtifactActionsClient({ serverId, accountId: ACCOUNT_ID });
    const docRead = { status: 'ready' as const, value: { ref: { kind: 'doc' as const, artifactId: 'doc-1', serverId }, openCommentCount: 1,
      artifact: { artifactId: 'doc-1', ownerAccountId: ACCOUNT_ID, access: 'owner' as const, publicAudience: 'none' as const,
        header: { title: 'Runbook' }, seq: 1, createdAt: 1, updatedAt: 2, body: 'Two rows.! Rest.', revision: base } } };
    const mount = () => renderScreen(
      <ArtifactEditProposal testID="proposal" client={client} docRead={docRead} proposalRef={{ ...proposalRef, discussion: { serverId, discussionId: 'd1' } }}
        proposal={proposal} viewerAccountId={ACCOUNT_ID} resolveAccountLabel={() => 'Ana'} disposition={undefined} />,
    );
    const first = await mount();
    await requestProposalApproval(serverId, 'accept');
    await waitForHomeGovernance(() => expect(approvals(serverId)).toHaveLength(1));
    await waitForHomeGovernance(() => expect(first.findByTestId('proposal.decisionPending')).not.toBeNull());
    expect(first.findByTestId('proposal.accept')).toBeNull();
    // Back to the thread: the card is mounted again and Accept is not offered a second time.
    await first.unmount();
    const second = await mount();
    await waitForHomeGovernance(() => expect(second.findByTestId('proposal.decisionPending')).not.toBeNull());
    expect(second.findByTestId('proposal.accept')).toBeNull();
    await decideApprovalAsInbox(serverId, approvals(serverId)[0]!.id, 'reject');
    await waitForHomeGovernance(() => expect(second.findByTestId('proposal.accept')).not.toBeNull());
    expect(second.findByTestId('proposal.decisionPending')).toBeNull();
    expect(approvals(serverId)).toHaveLength(1);
  });
});
