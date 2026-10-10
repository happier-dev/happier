import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createMachineFixture,
  createSessionFixture,
  renderScreen,
} from '@/dev/testkit';
import type {
  ArtifactHeader,
  DecryptedArtifact,
} from '@/sync/domains/artifacts/artifactTypes';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { installApprovalCommonModuleMocks } from '../../approvals/approvalsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const APPROVAL_ARTIFACT_HEADER: ArtifactHeader = {
  title: 'Approve answering the user',
  actionId: 'session.user_action.answer',
  sessionId: 'session-1',
};

function createApprovalArtifact(): Extract<
  DecryptedArtifact,
  { isDecrypted: true }
> {
  return {
    id: 'artifact-1',
    title: 'Approval',
    headerVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    isDecrypted: true,
    header: { ...APPROVAL_ARTIFACT_HEADER },
  };
}

const sessionFixtures: Record<string, Session> = {
  'session-1': createSessionFixture({
    id: 'session-1',
    metadata: {
      name: 'Repo session',
      path: '/Users/leeroy/stale-repo',
      host: 'tester.local',
      homeDir: '/Users/leeroy',
      machineId: 'machine-stale',
    },
  }),
};

const scopedSessionFixtures: Record<string, Session> = {
  'server-b:session-1': createSessionFixture({
    id: 'session-1',
    serverId: 'server-b',
    metadata: {
      name: 'Secondary Home session',
      path: '/Users/secondary/repo',
      host: 'secondary.local',
      homeDir: '/Users/secondary',
      machineId: 'machine-secondary',
    },
  }),
};

const machineFixtures: Record<string, Machine> = {
  'machine-target': createMachineFixture({
    id: 'machine-target',
    metadata: {
      displayName: 'Rebound workstation',
      host: 'workstation.local',
      platform: 'darwin',
      happyCliVersion: '0.0.0-test',
      happyHomeDir: '/Users/leeroy/.happy-dev',
      homeDir: '/Users/leeroy',
    },
  }),
};

const scopedMachineFixtures: Record<string, Machine> = {
  'server-b:machine-secondary': createMachineFixture({
    id: 'machine-secondary',
    metadata: {
      displayName: 'Secondary workstation',
      host: 'secondary.local',
      platform: 'darwin',
      happyCliVersion: '0.0.0-test',
      happyHomeDir: '/Users/secondary/.happy-dev',
      homeDir: '/Users/secondary',
    },
  }),
};

const storageState = {
  sessions: {
    'session-1': sessionFixtures['session-1'],
  },
  machines: {
    'machine-target': machineFixtures['machine-target'],
  },
  getProjectForSession: (sessionId: string) =>
    sessionId === 'session-1'
      ? {
          key: {
            machineId: 'machine-target',
            rootPath: '/Volumes/target/repo',
          },
        }
      : null,
};

installApprovalCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      Pressable: ({
        children,
        ...props
      }: {
        children?: React.ReactNode;
        [key: string]: unknown;
      }) => React.createElement('Pressable', props, children),
    });
  },
  unistyles: async () => {
    const { createUnistylesMock } =
      await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
      translate: (key: string) => key,
    });
  },
  storage: async () => {
    const { createStorageModuleStub } =
      await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      useSession: (sessionId: string) => sessionFixtures[sessionId] ?? null,
      useMachine: (machineId: string) => machineFixtures[machineId] ?? null,
      useSessionListRenderableWithServerScope: (
        serverId: string | null | undefined,
        sessionId: string,
      ) => scopedSessionFixtures[`${serverId ?? ''}:${sessionId}`] ?? null,
      useServerScopedMachine: (
        serverId: string | null | undefined,
        machineId: string,
      ) => scopedMachineFixtures[`${serverId ?? ''}:${machineId}`] ?? null,
      storage: {
        getState: () => storageState,
      },
    });
  },
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: ({
    title,
    subtitle,
    ...props
  }: {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    onPress?: () => void;
  }) =>
    React.createElement(
      'View',
      { ...props, accessibilityRole: props.onPress ? 'button' : undefined },
      React.createElement('Text', null, title),
      subtitle ? React.createElement('Text', null, subtitle) : null,
    ),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/sync/domains/server/serverProfiles')
  >()),
  areServerProfileIdentifiersEquivalent: (left: string, right: string) =>
    left === right,
  resolveServerProfileForPortableIdentity: (identity: string) =>
    identity === 'identity-b'
      ? {
          kind: 'resolved',
          serverIdentityId: identity,
          profile: { id: 'server-b', serverIdentityId: 'identity-b' },
        }
      : { kind: 'missing', serverIdentityId: identity },
  getServerProfileById: (serverId: string) =>
    serverId === 'server-b'
      ? {
          id: 'server-b',
          name: 'Home B',
          serverUrl: 'https://home-b.example.test',
        }
      : null,
}));

describe('ApprovalInboxCard', () => {
  it('shows the qualified plugin action without interpreting it as a built-in action', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'Publish release notes',
        kind: 'target_action_approval.v1',
        qualifiedActionId: 'acme.publisher/actions/releases/publish',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    // A plugin action is named by its request, never by its raw qualified id.
    expect(screen.getTextContent()).toContain('Publish release notes');
    expect(screen.getTextContent()).not.toContain(
      'acme.publisher/actions/releases/publish',
    );
    expect(screen.getTextContent()).toContain('inbox.work.rows.approvalNeeded');
    expect(
      screen.findByTestId(`inbox.approval.${artifact.id}`)?.props,
    ).toMatchObject({
      accessibilityRole: 'button',
    });
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).not.toContain('acme.publisher');
  });

  it('never repeats its title as the subtitle, and says what it needs instead', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        title: 'Respond to user-action request',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    const text = screen.getTextContent();
    expect(text.split('Respond to user-action request')).toHaveLength(2);
    // The session that asked tells this row from its siblings; "needs your approval" is not repeated.
    expect(text).toContain('Repo session');
    expect(text).not.toContain('inbox.work.rows.approvalNeeded');
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).toContain('inbox.work.rows.approvalNeeded');
  });

  it('drops the raw session id an older request stored after its title', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'Set Session lead — cmv06zc2b003itmv4tsr5fin7',
        actionId: 'session.user_action.answer',
        sessionId: 'cmv06zc2b003itmv4tsr5fin7',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('Set Session lead');
    expect(text).not.toContain('cmv06zc2b003itmv4tsr5fin7');
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).not.toContain('cmv06zc2b003itmv4tsr5fin7');
  });

  it('names an approval whose stored title is only its raw Action id by what it is', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'widgets.definition.update',
        actionId: 'widgets.definition.update',
        sessionId: 'session-1',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    // Titled by the Action's own name (or the plain fallback); the raw id is never copy.
    expect(screen.getTextContent()).not.toContain('widgets.definition.update');
    expect(
      String(screen.findByTestId(`inbox.approval.${artifact.id}`)?.props.accessibilityLabel ?? ''),
    ).not.toContain('widgets.definition.update');
  });

  it('says who asked on one line, without the machine, the folder or the Home address', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: { ...APPROVAL_ARTIFACT_HEADER, serverId: 'server-b' },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard artifact={artifact} onPress={() => {}} />,
    );

    const text = screen.getTextContent();
    expect(text).toContain('Secondary Home session');
    expect(text).not.toContain('Secondary workstation');
    expect(text).not.toContain('repo');
    expect(text).not.toContain('home-b.example.test');
    // One Home: naming it on every row would only repeat it.
    expect(text).not.toContain('Home B');
    expect(
      screen.findByTestId(`inbox.approval.${artifact.id}`)?.props.subtitleLines,
    ).toBe(1);
  });

  it('names the Home when the Inbox spans several', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={
          {
            ...createApprovalArtifact(),
            header: { ...APPROVAL_ARTIFACT_HEADER, serverId: 'server-b' },
          } satisfies DecryptedArtifact
        }
        onPress={() => {}}
        showHome
      />,
    );

    expect(screen.getTextContent()).toContain('Home B');
  });

  it('says where a session lives when this device does not have it, never its id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        serverId: 'server-b',
        sessionId: 'cmv06zc2b003itmv4tsr5fin7',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard artifact={artifact} onPress={() => {}} />,
    );

    const text = screen.getTextContent();
    expect(text).toContain('detailPages.approval.sessionOnHome');
    expect(text).not.toContain('cmv06zc2b003itmv4tsr5fin7');
    expect(text).not.toContain('home-b.example.test');
    expect(text).not.toContain('inbox.work.rows.approvalNeeded');
  });

  it('uses the approval Home when another Home has the same Session id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        serverId: 'server-b',
      },
    } satisfies DecryptedArtifact;

    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );

    expect(screen.getTextContent()).toContain('Secondary Home session');
    expect(screen.getTextContent()).not.toContain('Repo session');
    expect(screen.getTextContent()).not.toContain('/Users/secondary/repo');
  });

  it('finds the asking session through the Home identity when the request recorded another device’s Home id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        // The asking device's own profile id for the Home, unknown on this device.
        serverId: 'creator-local-home',
        serverIdentityId: 'identity-b',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );

    expect(screen.getTextContent()).toContain('Secondary Home session');
    expect(screen.getTextContent()).not.toContain(
      'inbox.work.rows.approvalNeeded',
    );
  });

  it('does not synthesize Home-wide freshness in approval context', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={
          {
            ...createApprovalArtifact(),
            header: { ...APPROVAL_ARTIFACT_HEADER, serverId: 'server-b' },
          } satisfies DecryptedArtifact
        }
        onPress={() => {}}
        nowMs={1_081_000}
      />,
    );

    expect(screen.getTextContent()).not.toContain('Offline');
    expect(screen.getTextContent()).not.toContain('Last updated');
  });

  it('names a locked qualified Session by where it lives without exposing cached private metadata', async () => {
    const previous = scopedSessionFixtures['server-b:session-1'];
    scopedSessionFixtures['server-b:session-1'] = createSessionFixture({
      id: 'session-1',
      serverId: 'server-b',
      encryptionMode: 'e2ee',
      encryptedContentAvailability: 'encrypted_access_pending',
      metadata: {
        name: 'Private cached Inbox title',
        path: '/Users/private/inbox-secret',
        host: 'secondary.local',
        homeDir: '/Users/private',
        machineId: 'machine-secondary',
      },
    });
    try {
      const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
      const screen = await renderScreen(
        <ApprovalInboxCard
          artifact={
            {
              ...createApprovalArtifact(),
              header: { ...APPROVAL_ARTIFACT_HEADER, serverId: 'server-b' },
            } satisfies DecryptedArtifact
          }
          onPress={() => {}}
        />,
      );

      expect(screen.getTextContent()).not.toContain(
        'Private cached Inbox title',
      );
      expect(screen.getTextContent()).not.toContain('inbox-secret');
      // A locked session reads by where it lives.
      expect(screen.getTextContent()).toContain('detailPages.approval.sessionOnHome');
    } finally {
      scopedSessionFixtures['server-b:session-1'] = previous;
    }
  });
});
