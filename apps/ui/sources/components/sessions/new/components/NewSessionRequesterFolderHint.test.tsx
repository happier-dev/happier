import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MachineAgentIsolationOwnStatusV1 } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
const { NewSessionRequesterFolderHint } = await import('./NewSessionRequesterFolderHint');
afterEach(() => standardCleanup());

type Isolation = React.ComponentProps<typeof NewSessionRequesterFolderHint>['isolation'];

async function render(isolation: Isolation) {
  return renderScreen(
    <NewSessionRequesterFolderHint isolation={isolation} testID="hint" />,
  );
}

const separated: MachineAgentIsolationOwnStatusV1 = {
  protection: 'member_separated',
  status: { kind: 'effective', platform: 'linux' },
  directories: { home: '/member/home', workspace: '/member/workspace' },
};
const shared: MachineAgentIsolationOwnStatusV1 = {
  protection: 'shared_user',
  status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
};

describe('NewSessionRequesterFolderHint (a member starting on someone else’s machine)', () => {
  it('says the folders are being checked while the requester read runs', async () => {
    const screen = await render({
      status: null,
      loading: true,
      failed: false,
      retry: vi.fn(),
    });
    expect(screen.findByTestId('hint.loading')).toBeTruthy();
    await screen.unmount();
  });

  it('says the check failed and retries that read once', async () => {
    const retry = vi.fn();
    const screen = await render({
      status: null,
      loading: false,
      failed: true,
      retry,
    });
    expect(screen.findByTestId('hint.failed')).toBeTruthy();
    await act(async () => screen.pressByTestId('hint.failed.retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it('points a separated member at their own workspace or home', async () => {
    const screen = await render({
      status: separated,
      loading: false,
      failed: false,
      retry: vi.fn(),
    });
    expect(screen.findByTestId('hint.member')).toBeTruthy();
    await screen.unmount();
  });

  it('tells an enrolled member when their workspace will be prepared', async () => {
    const screen = await render({
      status: { protection: 'setup_pending', status: { kind: 'member_not_prepared' } },
      loading: false,
      failed: false,
      retry: vi.fn(),
    });
    expect(screen.findByTestId('hint.pending')).toBeTruthy();
    await screen.unmount();
  });

  it('draws nothing on a machine that runs sessions as its owner, or with no requester read', async () => {
    for (const isolation of [
      { status: shared, loading: false, failed: false, retry: vi.fn() },
      undefined,
    ]) {
      const screen = await render(isolation);
      expect(screen.findByTestId('hint.member')).toBeFalsy();
      expect(screen.findByTestId('hint.loading')).toBeFalsy();
      expect(screen.findByTestId('hint.failed')).toBeFalsy();
      await screen.unmount();
    }
  });
});
