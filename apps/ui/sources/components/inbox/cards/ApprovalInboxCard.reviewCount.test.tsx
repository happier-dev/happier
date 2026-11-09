import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { installApprovalCommonModuleMocks } from '../../approvals/approvalsTestHelpers';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installApprovalCommonModuleMocks({ text: () => vi.importActual('@/text') });
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Counts the shared approval review owner's derivations; the real review still runs underneath.
vi.mock('@/components/approvals/actionApprovalReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/approvals/actionApprovalReview')>();
  return { ...actual, readActionApprovalReview: vi.fn(actual.readActionApprovalReview) };
});

const initialState = storage.getState();
let serverId = '';
beforeEach(async () => {
  await upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B' });
  const profile = await setServerProfileIdentityForUrl('https://home-b.example.test', 'srv_approval_home_b');
  if (!profile) throw new Error('Expected the approval Home profile');
  serverId = profile.id;
  const session = createSessionFixture({ id: 'session-1' });
  storage.setState({ sessions: { [session.id]: session } });
});
afterEach(async () => {
  standardCleanup();
  storage.setState(initialState, true);
  if (serverId) await removeServerProfile(serverId);
});

it('derives a mounted row\'s review once per approval version, not on every parent render', async () => {
  const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
  const { readActionApprovalReview } = await import('@/components/approvals/actionApprovalReview');
  const reviews = vi.mocked(readActionApprovalReview);
  const artifactFor = (summary: string, bodyVersion: number) => {
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: bodyVersion,
      createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' },
      summary, executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
        caller: { kind: 'host' }, serverId, actionId: 'account.name.set', requestId: 'request-a' } });
    return { id: 'artifact-1', title: summary, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: bodyVersion, isDecrypted: true,
      bodyVersion, header: { ...buildApprovalRequestArtifactHeaderV1(request), sessionId: 'session-1' },
      body: JSON.stringify(request) } satisfies DecryptedArtifact;
  };
  const artifact = artifactFor('Change name', 1);
  reviews.mockClear();
  const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} decideBelow onPress={() => {}} />);
  expect(screen.findHostByTestId(`inbox.approval.${artifact.id}.allow_once`)).toBeTruthy();
  const counts = { mount: reviews.mock.calls.length, parentRender: 0, versionChange: 0 };
  reviews.mockClear();
  // The list re-renders the row with a fresh handler: the approval itself did not change.
  await screen.update(<ApprovalInboxCard artifact={artifact} decideBelow onPress={() => {}} />);
  await screen.update(<ApprovalInboxCard artifact={artifact} decideBelow onPress={() => {}} />);
  counts.parentRender = reviews.mock.calls.length;
  reviews.mockClear();
  await screen.update(<ApprovalInboxCard artifact={artifactFor('Rename', 2)} decideBelow onPress={() => {}} />);
  counts.versionChange = reviews.mock.calls.length;
  // One review of the row's request (verb, irreversibility) plus the strict quick-decision admission.
  expect(counts).toEqual({ mount: 2, parentRender: 0, versionChange: 2 });
}, 240_000);
