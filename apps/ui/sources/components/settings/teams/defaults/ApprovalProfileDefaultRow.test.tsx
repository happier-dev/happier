import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';
import { APPROVAL_PROFILE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import type { ProjectSessionDefaultsV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { t } from '@/text';

// Native presentation SDKs and sockets are the boundaries; the defaults editor, profile catalog, Artifact grant
// review and Action executor stay real over the Home's HTTP routes.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('socket.io-client', async (original) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(original),
);
installDisconnectedServerSocketBoundary();
const { ModalProvider } = await import('@/modal');
const { ProjectSessionDefaultsSection } =
  await import('./TeamMemberDefaultsSection');
const { storage } = await import('@/sync/domains/state/storage');
const originalState = storage.getState();

let account:
  | Awaited<ReturnType<typeof createSecretSettingsTestHarness>>
  | undefined;
let disposeLoader: (() => void) | undefined;
let restoreWeb: (() => void) | undefined;
afterEach(async () => {
  restoreWeb?.();
  restoreWeb = undefined;
  disposeLoader?.();
  await account?.dispose();
  account = undefined;
  standardCleanup();
  storage.setState(originalState, true);
});

function profileArtifact(
  profile: Pick<ApprovalProfileV1, 'id' | 'name'>,
  ownerAccountId: string,
) {
  const header = {
    kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1,
    name: profile.name,
    title: profile.name,
  };
  return createPlainArtifactHttpFixture(
    {
      id: profile.id,
      isDecrypted: true,
      title: profile.name,
      header,
      rawHeader: header,
      body: JSON.stringify({
        kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1,
        profile: { name: profile.name },
      }),
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    ownerAccountId,
  );
}

describe('Approval profile default in the project defaults editor', () => {
  it('picks a profile, offers the share to the project Team, sets None and clears back to the inherited default', async () => {
    const team = { id: 'team-payments', name: 'Payments' };
    const release = { id: 'artifact-release', name: 'Release week' };
    const reviewed = { id: 'artifact-reviewed', name: 'Reviewed writes' };
    account = await createSecretSettingsTestHarness({ mode: 'plain' });
    account.artifacts.replaceStoredRow(
      profileArtifact(release, account.scope.accountId),
    );
    account.artifacts.replaceStoredRow(
      profileArtifact(reviewed, account.scope.accountId),
    );
    disposeLoader = await installRealActionExecutorModuleLoader();
    // The picker's menu is a web popover that measures its window.
    restoreWeb = withPopoverWebGlobals();
    const writes: (ProjectSessionDefaultsV1 | null)[] = [];
    const save = async (next: ProjectSessionDefaultsV1 | null) => {
      writes.push(next);
    };
    // The Team's own default is Reviewed writes, so clearing the project field restores it.
    const context = {
      primaryTeamId: team.id,
      teamDefaults: { team: { approvalProfileId: reviewed.id }, groups: {} },
    };
    const element = (defaults: ProjectSessionDefaultsV1) => (
      <ModalProvider>
        <ProjectSessionDefaultsSection
          testID="defaults"
          serverId={account!.scope.serverId}
          teamId={team.id}
          defaults={defaults}
          save={save}
          scope="project"
          context={context}
          teamName={team.name}
          projectName="payments/web"
          editable
          busy={false}
        />
      </ModalProvider>
    );
    const screen = await renderScreen(element({}));
    const menu = () =>
      screen.findAll(
        (node) =>
          node.props.testID === 'defaults-approvalProfile' &&
          typeof node.props.onSelect === 'function',
      )[0];
    const pick = async (id: string) => {
      await act(async () => {
        menu()!.props.onOpenChange(true);
      });
      await vi.waitFor(() =>
        expect(
          menu()!.props.items.map((item: { id: string }) => item.id),
        ).toContain(release.id),
      );
      await act(async () => {
        menu()!.props.onSelect(id);
      });
    };
    try {
      // Nothing set on the project: the field shows the Team's profile it falls back to, by name.
      await vi.waitFor(() =>
        expect(screen.getTextContent()).toContain(reviewed.name),
      );
      expect(screen.getTextContent()).toContain(
        t('teams.settings.memberDefaults.approvalProfileProject'),
      );

      // A profile the Team can't see yet is offered for sharing in the same step; nothing saves until they choose.
      await pick(release.id);
      await vi.waitFor(() =>
        expect(
          screen.findAll(
            (node) => node.props.testID === 'defaults-approvalProfile-share',
          ).length,
        ).toBeGreaterThan(0),
      );
      expect(writes).toEqual([]);
      expect(screen.getTextContent()).not.toContain(team.id);
      await screen.pressByTestIdAsync('defaults-approvalProfile-share.share');
      await vi.waitFor(() =>
        expect(writes).toEqual([{ approvalProfileId: release.id }]),
      );
      expect(account.artifacts.readGrants(release.id)).toEqual([
        expect.objectContaining({
          principal: { kind: 'team', teamId: team.id },
          accessLevel: 'view',
        }),
      ]);

      // Once the Team sees it, picking it again saves at once with no share offer.
      await screen.update(element({ approvalProfileId: reviewed.id }));
      await pick(release.id);
      await vi.waitFor(() =>
        expect(writes.at(-1)).toEqual({ approvalProfileId: release.id }),
      );
      expect(
        screen.findAll(
          (node) => node.props.testID === 'defaults-approvalProfile-share',
        ),
      ).toHaveLength(0);

      // None is an explicit choice, distinct from clearing back to what the Team sets.
      await screen.update(element({ approvalProfileId: release.id }));
      await pick('none');
      await vi.waitFor(() =>
        expect(writes.at(-1)).toEqual({ approvalProfileId: null }),
      );
      await screen.update(element({ approvalProfileId: null }));
      await pick('inherit');
      await vi.waitFor(() => expect(writes.at(-1)).toBeNull());
      expect(account.artifacts.readGrants(reviewed.id)).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });
});
