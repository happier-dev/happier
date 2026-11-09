import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { storage } from '@/sync/domains/state/storageStore';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { installApprovalCommonModuleMocks } from '../../approvals/approvalsTestHelpers';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installApprovalCommonModuleMocks({ text: () => vi.importActual('@/text') });
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// The primary pointer is read once per load, so a finger is a file of its own (a browser boundary).
const initialState = storage.getState();
let serverId = '';
beforeEach(async () => {
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  await upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B' });
  const profile = await setServerProfileIdentityForUrl('https://home-b.example.test', 'srv_approval_home_b');
  if (!profile) throw new Error('Expected the approval Home profile');
  serverId = profile.id;
  const session = createSessionFixture({ id: 'session-1' });
  storage.setState({ sessions: { [session.id]: session } });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  standardCleanup();
  storage.setState(initialState, true);
  if (serverId) await removeServerProfile(serverId);
});

it('keeps its answer pills out of the row they sit in: a finger reaches them only sideways', async () => {
  const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' },
    summary: 'Change name', executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
      caller: { kind: 'host' }, serverId, actionId: 'account.name.set', requestId: 'request-a' } });
  const simple = { id: 'artifact-1', title: 'Approval', headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true,
    header: { ...buildApprovalRequestArtifactHeaderV1(request), sessionId: 'session-1' }, body: JSON.stringify(request) } satisfies DecryptedArtifact;
  const screen = await renderScreen(<ApprovalInboxCard artifact={simple} decideBelow narrow onPress={() => {}} />);
  for (const id of ['allow_once', 'deny']) {
    const testID = `inbox.approval.${simple.id}.${id}`;
    const pill = screen.findHostByTestId(testID)!;
    await act(async () => (pill.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 80, height: 30 } } }));
    expect(readHitArea(screen.findHostByTestId(testID)!, { width: 80, height: 30 }).insets).toMatchObject({ top: 0, bottom: 0 });
  }
});
