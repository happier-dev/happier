import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionSectionActionPortV1, SessionSectionFolderV1 } from '@happier-dev/protocol/actions/sessionSections';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

type Controller = ReturnType<
  typeof import('./useSessionSectionDraft').useSessionSectionDraft
>;

async function mountController() {
  const { useSessionSectionDraft } = await import('./useSessionSectionDraft');
  const ref: { current: Controller | null } = { current: null };
  function Probe() {
    ref.current = useSessionSectionDraft();
    return null;
  }
  const screen = await renderScreen(<Probe />);
  return { ref, screen };
}

const header = (groupKey: string, headerKind: string) =>
  ({
    type: 'header',
    groupKey,
    headerKind,
    title: groupKey,
  }) as unknown as SessionListIndexItem;

describe('useSessionSectionDraft (inline New section, lab clsections:custom)', () => {
  afterEach(() => standardCleanup());

  it('opens one inline field, creates on Enter and settles the request only after the create lands', async () => {
    const { ref } = await mountController();
    let finishCreate: (ok: boolean) => void = () => {};
    const create = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCreate = resolve;
        }),
    );
    let settled: boolean | null = null;
    await act(async () => {
      void ref.current!.request('home-a', create).then((ok) => {
        settled = ok;
      });
    });
    expect(ref.current!.draft).toMatchObject({
      serverId: 'home-a',
      phase: 'editing',
    });

    await act(async () => {
      ref.current!.submit('  Payments  ');
    });
    expect(create).toHaveBeenCalledWith('Payments');
    // The field holds the entered name while the section is created; it does not vanish first.
    expect(ref.current!.draft).toMatchObject({
      phase: 'creating',
      name: 'Payments',
    });
    expect(settled).toBeNull();

    await act(async () => {
      finishCreate(true);
    });
    expect(settled).toBe(true);
    expect(ref.current!.draft).toBeNull();
  });

  it('keeps the entered name when creation fails, and a cancel settles the request as not created', async () => {
    const { ref } = await mountController();
    const create = vi.fn(async () => {
      throw new Error('offline');
    });
    let settled: boolean | null = null;
    await act(async () => {
      void ref.current!.request('home-a', create).then((ok) => {
        settled = ok;
      });
    });
    await act(async () => {
      ref.current!.submit('Payments');
    });
    expect(ref.current!.draft).toMatchObject({
      phase: 'editing',
      name: 'Payments',
      failed: true,
    });
    expect(settled).toBeNull();

    await act(async () => {
      ref.current!.cancel();
    });
    expect(settled).toBe(false);
    expect(ref.current!.draft).toBeNull();
  });

  it('an empty name cancels, and a second request supersedes the first', async () => {
    const { ref } = await mountController();
    const results: boolean[] = [];
    await act(async () => {
      void ref
        .current!.request('home-a', async () => true)
        .then((ok) => results.push(ok));
    });
    await act(async () => {
      void ref
        .current!.request('home-b', async () => true)
        .then((ok) => results.push(ok));
    });
    expect(results).toEqual([false]);
    expect(ref.current!.draft).toMatchObject({ serverId: 'home-b' });
    await act(async () => {
      ref.current!.submit('   ');
    });
    expect(results).toEqual([false, false]);
    expect(ref.current!.draft).toBeNull();
  });

  it('anchors the field where a new section lands: after the sections, before the first ordinary group', async () => {
    const { resolveSessionSectionDraftAnchor } =
      await import('./useSessionSectionDraft');
    const source = { serverId: 'home-a', sections: [] };
    expect(
      resolveSessionSectionDraftAnchor([
        header('attention:needs', 'attention'),
        header('pinned', 'pinned'),
        header('section:a', 'folder'),
        header('project:happier', 'project'),
        header('project:web', 'project'),
      ], source),
    ).toEqual({ groupKey: 'project:happier', placement: 'before' });
    expect(
      resolveSessionSectionDraftAnchor([
        header('pinned', 'pinned'),
        header('day:today', 'date'),
      ], source),
    ).toEqual({ groupKey: 'day:today', placement: 'before' });
    // An ungrouped "Sessions" band is an ordinary group too: the field sits above it, after the sections.
    expect(
      resolveSessionSectionDraftAnchor([header('section:a', 'folder'), header('sessions', 'sessions'), header('project:a', 'project')], source),
    ).toEqual({ groupKey: 'sessions', placement: 'before' });
    // No ordinary group drawn: below the last section (or the last group), never nowhere.
    expect(
      resolveSessionSectionDraftAnchor([
        header('pinned', 'pinned'),
        header('section:a', 'folder'),
      ], source),
    ).toEqual({ groupKey: 'section:a', placement: 'after' });
    expect(resolveSessionSectionDraftAnchor([], source)).toBeNull();
  });

  it.each([
    { keys: ['a0', 'a0', 'a1', 'a30', null], beforeId: 'legacy-3' },
    { keys: ['0001', 'zzz', null], beforeId: 'legacy-1' },
  ])('keeps the draft at the real create landing spot among retained keys $keys', async ({ keys, beforeId }) => {
    const { executeSessionSectionActionV1, SessionSectionResultV1Schema } = await import('@happier-dev/protocol/actions/sessionSections');
    const { buildSessionOrganizationProjection } = await import('@/sync/domains/session/organization/projection');
    const { buildSessionOrganizationServerKey } = await import('@/sync/domains/session/organization/keys');
    const { projectSessionOrganizationSections, projectSessionSectionListIndex, buildSessionSectionGroupKey } =
      await import('@/sync/domains/session/organization/sections');
    const { resolveSessionSectionDraftAnchor } = await import('./useSessionSectionDraft');
    const serverId = 'home-b';
    const folders: SessionSectionFolderV1[] = keys.map((sortKey, index) => ({
      folderId: `legacy-${index}`, folderKey: `legacy-${index}`, parentFolderId: null, parentFolderKey: null,
      sortKey, display: { t: 'plain', v: { name: `Legacy ${index}` } },
      displayState: index >= 2 ? { status: 'locked', reason: 'invalid_stored_display' }
        : { status: 'available', value: { name: `Legacy ${index}` } },
      archivedAt: null, createdAt: 1, updatedAt: 1,
    }));
    const readSections = () => projectSessionOrganizationSections(serverId, buildSessionOrganizationProjection({
      schemaVersionByServerId: { [serverId]: 1 }, snapshotVersionByServerId: { [serverId]: 1 }, pinsBySessionKey: {},
      appearancesBySessionKey: {}, sessionAppearancesSupportedByServerId: {},
      foldersByFolderKey: Object.fromEntries(folders.map(folder => [buildSessionOrganizationServerKey(serverId, folder.folderId), folder])),
      folderAssignmentsBySessionKey: {}, tagsByTagKey: {}, tagAssignmentsBySessionKey: {},
      attentionStandingsBySessionKey: {}, orderEntriesByScopeKey: {}, labelsByLabelKey: {},
    }, serverId));
    const sections: ReturnType<typeof readSections> = [{ address: { serverId: 'home-a', sectionId: beforeId }, sortKey: 'a9',
      display: { status: 'available', value: { name: 'Other Home', icon: null } } }, ...readSections()];
    const project: SessionListIndexItem = { type: 'header', headerKind: 'project', serverId, groupKey: 'project:b', title: 'Project B' };
    const items = [header('attention:needs', 'attention'), header('pinned', 'pinned'),
      ...projectSessionSectionListIndex({ source: [project], sections, assignmentsBySessionKey: {} }).items];
    const beforeGroupKey = buildSessionSectionGroupKey({ serverId, sectionId: beforeId });
    expect(resolveSessionSectionDraftAnchor(items, { serverId, sections }))
      .toEqual({ groupKey: beforeGroupKey, placement: 'before' });
    const port: SessionSectionActionPortV1 = {
      assertCurrent: () => {}, allocateFolderId: () => 'created',
      readSnapshot: async () => ({ folders, folderAssignments: [] }),
      upsertFolder: async request => {
        const created: SessionSectionFolderV1 = { ...request, folderId: request.folderId!, archivedAt: null, createdAt: 2, updatedAt: 2,
          displayState: { status: 'available', value: request.display?.t === 'plain' ? request.display.v : null } };
        folders.push(created);
        return created;
      },
      deleteFolder: async () => { throw new Error('unexpected_delete'); },
      setAssignment: async () => { throw new Error('unexpected_assignment'); },
    };
    const created = SessionSectionResultV1Schema.parse(await executeSessionSectionActionV1('session.sections.create', { name: 'Payments' }, port)).section;
    const committedItems = projectSessionSectionListIndex({ source: [project], sections: readSections(), assignmentsBySessionKey: {} }).items;
    const createdIndex = committedItems.findIndex(item => item.type === 'header'
      && item.groupKey === buildSessionSectionGroupKey({ serverId, sectionId: created.sectionId }));
    expect(committedItems[createdIndex + 1]).toMatchObject({ type: 'header', groupKey: beforeGroupKey });
  });
});
