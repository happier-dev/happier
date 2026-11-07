import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateOrUpdateSessionOrganizationFolderRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import type { SessionOrganizationFolder } from '@happier-dev/protocol/sessions/organization/folders';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const modal = vi.hoisted(() => ({
  prompt: vi.fn(),
  confirm: vi.fn(),
  alert: vi.fn(),
}));
// The dialog presentation is the platform boundary; what each answer writes stays real.
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({
    spies: { prompt: modal.prompt, confirm: modal.confirm, alert: modal.alert },
  }).module;
});
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
  standardCleanup();
  modal.prompt.mockReset();
  modal.confirm.mockReset();
  modal.alert.mockReset();
  retireActiveServerAccountScopeLifetime();
  await home?.dispose();
  home = undefined;
});

describe('Settings section organizer', () => {
  it('creates, renames, reorders and removes sections through the section Actions on the selected Home', async () => {
    let folders: SessionOrganizationFolder[] = [];
    const writes: string[] = [];
    home = await serveActionHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://section-organizer.test',
          accountId: 'account-a',
        },
      ],
      route: (request) => {
        if (request.path === '/v1/kv/bulk')
          return Response.json({ values: [] });
        if (
          request.method === 'GET' &&
          request.path === '/v2/session-organization'
        )
          return Response.json({
            snapshot: {
              schemaVersion: 1,
              version: 1,
              pins: [],
              tags: [],
              tagAssignments: [],
              orderEntries: [],
              labels: [],
              folders,
              folderAssignments: [],
            },
          });
        if (
          request.method === 'POST' &&
          request.path === '/v2/session-organization/folders'
        ) {
          const input =
            CreateOrUpdateSessionOrganizationFolderRequestSchema.parse(
              request.body,
            );
          const previous = folders.find(
            (folder) => folder.folderId === input.folderId,
          );
          const folder: SessionOrganizationFolder = {
            ...input,
            folderId: input.folderId!,
            folderKey: input.folderKey ?? input.folderId!,
            parentFolderId: input.parentFolderId ?? null,
            parentFolderKey: input.parentFolderKey ?? null,
            sortKey: input.sortKey ?? null,
            display: input.display ?? null,
            archivedAt: null,
            createdAt: previous?.createdAt ?? 1,
            updatedAt: 2,
          };
          writes.push(previous ? 'update' : 'create');
          folders = [
            ...folders.filter(
              (current) => current.folderId !== folder.folderId,
            ),
            folder,
          ];
          return Response.json({ folder });
        }
        if (
          request.method === 'DELETE' &&
          request.path.startsWith('/v2/session-organization/folders/')
        ) {
          const folderId = decodeURIComponent(request.path.split('/').at(-1)!);
          writes.push(`delete:${folderId}`);
          folders = folders.filter((folder) => folder.folderId !== folderId);
          return Response.json({
            deletedFolderIds: [folderId],
            assignmentTargetFolderId: null,
            affectedAssignmentCount: 0,
          });
        }
        return undefined;
      },
    });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({
      serverId: server.id,
      serverUrl: server.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      server.serverUrl,
    ))!;
    const { useSessionSectionsOrganizer } =
      await import('./useSessionSectionsOrganizer');
    let organizer: ReturnType<typeof useSessionSectionsOrganizer> | null = null;
    function Probe() {
      organizer = useSessionSectionsOrganizer();
      return null;
    }
    await renderScreen(
      <InjectedAuthProvider credentials={credentials}>
        <Probe />
      </InjectedAuthProvider>,
    );
    const titles = () => organizer!.sections.map((section) => section.title);

    modal.prompt.mockResolvedValueOnce('Launch');
    await act(async () => {
      await organizer!.create();
    });
    modal.prompt.mockResolvedValueOnce('  Backlog ');
    await act(async () => {
      await organizer!.create();
    });
    await waitForHomeGovernance(() =>
      expect(titles()).toEqual(['Launch', 'Backlog']),
    );

    const launch = organizer!.sections[0]!.sectionId;
    const backlog = organizer!.sections[1]!.sectionId;
    // An unchanged or empty name writes nothing.
    modal.prompt.mockResolvedValueOnce('Launch');
    await act(async () => {
      await organizer!.rename(launch);
    });
    modal.prompt.mockResolvedValueOnce('Release');
    await act(async () => {
      await organizer!.rename(launch);
    });
    await waitForHomeGovernance(() =>
      expect(titles()).toEqual(['Release', 'Backlog']),
    );

    // The grip, its keyboard path and the move chooser all submit this one reorder Action.
    const admission = organizer!.reorder.resolve(backlog, {
      anchorId: launch,
      placement: 'before',
    });
    expect(admission).toMatchObject({
      status: 'allowed',
      effect: {
        actionId: 'session.sections.reorder',
        input: { sectionId: backlog, beforeSectionId: launch },
      },
    });
    expect(
      organizer!.reorder.resolve(launch, {
        anchorId: backlog,
        placement: 'before',
      }),
    ).toMatchObject({ status: 'refused' });
    if (admission.status !== 'allowed')
      throw new Error('Expected an allowed reorder');
    let outcome: unknown;
    await act(async () => {
      outcome = await organizer!.reorder.execute(admission.effect);
    });
    expect(outcome).toEqual({ status: 'applied' });
    await waitForHomeGovernance(() =>
      expect(titles()).toEqual(['Backlog', 'Release']),
    );

    // Remove asks once; declining writes nothing.
    modal.confirm.mockResolvedValueOnce(false);
    await act(async () => {
      await organizer!.remove(launch);
    });
    modal.confirm.mockResolvedValueOnce(true);
    await act(async () => {
      await organizer!.remove(launch);
    });
    expect(modal.confirm).toHaveBeenCalledTimes(2);
    await waitForHomeGovernance(() => expect(titles()).toEqual(['Backlog']));
    expect(writes.filter((write) => write !== 'update')).toEqual([
      'create',
      'create',
      `delete:${launch}`,
    ]);
    expect(modal.alert).not.toHaveBeenCalled();
  });
});
