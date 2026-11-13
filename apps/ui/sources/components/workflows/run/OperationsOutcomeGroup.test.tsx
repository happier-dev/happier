import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Modal } from '@/modal';

import { OperationsOutcomeGroup } from './OperationsOutcomeGroup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

const routerMock = vi.hoisted(() => ({ push: null as null | ReturnType<typeof vi.fn> }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mocked = createExpoRouterMock();
  routerMock.push = mocked.spies.push;
  return mocked.module;
});

const session = { serverId: 'srv', sessionId: 'ses-1' };
const full = '## What failed\n\n- `db push` never ran';
const input = {
  subject: { kind: 'deploymentReceipt', serverId: 'srv', environmentId: 'env', deploymentId: 'dep-1' },
  finding: {
    kind: 'investigate', session,
    result: {
      preview: { state: 'available', text: 'What failed db push never ran' },
      output: { text: full, messageRef: { kind: 'session', session, messageId: 'm-1' } },
      workflowInvocation: null, completedAt: 1,
    },
  },
  produced: {
    pullRequests: [{ title: 'Fix the migration', url: 'https://example.test/pr/12', number: 12, state: 'open' }],
    approvals: [{ serverId: 'srv', status: 'open', request: { artifactId: 'appr-1' } }],
    operations: [{ serverId: 'srv', snapshot: { operationId: 'cmd-1', title: 'pnpm test', state: 'succeeded',
      scope: { machineId: 'm-1' }, domainRef: { kind: 'projectCommand', exitCode: 0 } } }],
    pendingOperations: [],
    receipts: [{ serverId: 'srv', environmentId: 'env', deploymentId: 'new', state: 'succeeded' }],
  },
} as never;

afterEach(async () => {
  vi.restoreAllMocks();
  routerMock.push?.mockClear();
  await standardCleanup();
  await homes.reset();
});

describe('OperationsOutcomeGroup', () => {
  async function mount(open = vi.fn()) {
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}>
        <OperationsOutcomeGroup input={input} testID="o" openReceipt={{ serverId: 'srv', open }} />
      </InjectedAuthProvider>,
    );
    return { screen, onOpenReceipt: open };
  }

  it('draws the full finding and opens commands, the approval and the receipt where they already live', async () => {
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal');
    const { screen, onOpenReceipt } = await mount();
    expect(screen.findByType(MarkdownView).props.markdown).toBe(full);

    await screen.pressByTestIdAsync('o.finding.link.operation.cmd-1');
    expect(show.mock.calls[0]?.[0]).toMatchObject({ props: { serverId: 'srv', operationId: 'cmd-1' } });

    await screen.pressByTestIdAsync('o.proposal.link.approval.appr-1');
    expect(routerMock.push?.mock.calls[0]?.[0]).toBe('/inbox/approvals/appr-1?serverId=srv');

    await screen.pressByTestIdAsync('o.applied');
    expect(onOpenReceipt).toHaveBeenCalledWith('env', 'new');
  });

  it('opens the pull request the proposal row names only when its Action is allowed', async () => {
    const serverId = await homes.addHome({ name: 'Workflow outcome', serverUrl: 'https://workflow-outcome.test', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storageStore');
    await storage.getState().activateSettingsScope({ serverId, accountId: 'owner' });
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { screen } = await mount();
    await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'off');
    await screen.pressByTestIdAsync('o.proposal');
    expect(open).not.toHaveBeenCalled();
    await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'allowed');
    await screen.pressByTestIdAsync('o.proposal');
    expect(open).toHaveBeenCalledWith('https://example.test/pr/12', '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });
});
