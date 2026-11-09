import { describe, expect, it } from 'vitest';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { OpenProjectDraftSelectionV1Schema } from '@happier-dev/protocol/projects/openProjectDraftV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/drafts/sessionDrafts';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { buildWorkspaceContentPolicy } from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { MMKV } from 'react-native-mmkv';
import { scopedStorageId } from '@/utils/system/storageScope';
import { resetServerProfilesRuntimeForTests, resolveServerProfileScopeIdForIdentifier, type ServerProfile } from '@/sync/domains/server/serverProfiles';

import {
  buildProjectOpenDraft,
  buildProjectOpenInput,
  projectOpenChoiceStateFromDraft,
  resolveProjectOpenDefaults,
  resolveProjectOpenUseOptions,
  suggestProjectOpenDestination,
  type ProjectOpenChoiceState,
} from './projectOpenChoices';

describe('retained whole-repository Source selections', () => {
  it.each(['.', './', ''])('projects a legacy root selection without a raw folder label (%j)', subdir => {
    const state = projectOpenChoiceStateFromDraft({ serverId: 'home', source: {
      kind: 'source', id: 'source', revision: 1, subdir,
      selector: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' },
    } }, [], null);
    expect(state.subject?.kind).toBe('source');
    if (state.subject?.kind === 'source') expect(state.subject.source.subdir).toBeUndefined();
  });
});

const source = {
  id: 'source-happier',
  revision: 3,
  name: 'happier',
  audience: [],
  createdByAccountId: 'me',
  repository: {
    provider: {
      id: 'happier.scm.forge.github/github',
      kind: 'github',
      displayName: 'GitHub',
      baseUrl: 'https://github.com',
    },
    repository: { nameWithOwner: 'happier-dev/happier', visibility: 'public' },
    protocol: 'https',
  },
  defaultRef: 'v0.3',
} satisfies ProjectSourceV1;
const checkout = (
  id: string,
  machineId: string,
  rootPath: string,
): WorkspaceRefV1 => ({
  id,
  serverId: 'home',
  machineId,
  rootPath,
  createdAtMs: 1,
  source: { sourceId: source.id, revision: 3 },
});
const base: ProjectOpenChoiceState = {
  serverId: 'home',
  machineId: 'devbox',
  machineHomeDir: '/home/me',
  subject: { kind: 'source', source },
  ref: null,
  use: null,
  branch: '',
  destination: '',
  checkouts: [],
};

describe('Project Open choices', () => {
  it('leaves a cleared subfolder and ref out of the request, so the attempt can be retained as a draft (TL-A 11-08)', () => {
    const draft = OpenProjectDraftSelectionV1Schema.parse({ serverId: 'home', machineId: 'devbox',
      source: { kind: 'repository', selector: source.repository }, subdir: 'no-such-folder', ref: 'gone',
      materialization: { kind: 'clone', destinationParentPath: '/home/me', destinationDirectoryName: 'checkout' },
      editing: { destination: '/home/me/checkout', branch: '', subdir: '', ref: '' } });
    const input = buildProjectOpenInput(draft, []);
    expect(input).not.toBeNull();
    expect(input).not.toHaveProperty('subdir');
    expect(input).not.toHaveProperty('ref');
    expect(StrictJsonValueSchema.safeParse(input).success).toBe(true);
  });

  it('offers an unbound checkout by resolved repository identity and retains its exact address for Source attach', () => {
    const existing: WorkspaceRefV1 = { id: 'folder-picked', serverId: 'home', machineId: 'devbox',
      rootPath: '/home/me/existing', createdAtMs: 1, projectKey: 'private-project',
      repositoryIdentity: { kind: 'github', deployment: 'https://github.com/', repository: 'HAPPIER-DEV/HAPPIER' } };
    const state = { ...base, checkouts: [existing] };
    const options = resolveProjectOpenUseOptions(state);
    expect(options.map(option => option.use)).toEqual(['existing', 'worktree', 'clone']);
    expect(options[0]?.from).toBe(existing);
    const selected = { ...state, ...resolveProjectOpenDefaults(state) };
    expect(buildProjectOpenInput(buildProjectOpenDraft(selected), state.checkouts)).toMatchObject({
      source: { kind: 'source', id: source.id, checkout: { serverId: 'home', machineId: 'devbox',
        workspaceId: existing.id, rootPath: existing.rootPath } }, materialization: { kind: 'attach' },
    });
    expect(existing.source).toBeUndefined();
    expect(existing.projectKey).toBe('private-project');
  });

  it('keeps repository candidates Home-qualified, excludes other deployments and repositories, and preserves ambiguity', () => {
    const identity = { kind: 'github' as const, deployment: 'https://github.com', repository: 'happier-dev/happier' };
    const candidate = (id: string, patch: Partial<WorkspaceRefV1> = {}): WorkspaceRefV1 => ({
      id, serverId: 'home', machineId: 'devbox', rootPath: `/${id}`, createdAtMs: 1, repositoryIdentity: identity, ...patch,
    });
    const checkouts = [candidate('one'), candidate('two'), candidate('foreign-home', { serverId: 'another-home' }),
      candidate('foreign-forge', { repositoryIdentity: { ...identity, deployment: 'https://github.example' } }),
      candidate('other-repository', { repositoryIdentity: { ...identity, repository: 'another/repo' } }),
      candidate('unknown', { repositoryIdentity: undefined })];
    const state = { ...base, checkouts };
    const existing = resolveProjectOpenUseOptions(state)[0]!;
    expect(existing.candidates.map(ref => ref.id)).toEqual(['one', 'two']);
    expect(existing.from).toBeNull();
    expect(resolveProjectOpenDefaults(state)).toEqual({ use: 'existing' });
  });

  it('offers no repository action or destination for a Source without a repository, even with retained checkouts', () => {
    const { repository: _repository, ...withoutRepository } = source;
    const state: ProjectOpenChoiceState = { ...base, subject: { kind: 'source', source: withoutRepository },
      checkouts: [checkout('here', 'devbox', '/repo'), checkout('elsewhere', 'mac', '/repo')] };
    expect(resolveProjectOpenUseOptions(state)).toEqual([]);
    expect(suggestProjectOpenDestination(state)).toBe('');
    const draft = buildProjectOpenDraft({ ...state, use: 'clone', destination: '/home/me/src/repo' });
    expect(OpenProjectDraftSelectionV1Schema.safeParse(draft).success).toBe(true);
    expect(buildProjectOpenInput(draft, state.checkouts)).toBeNull();
  });

  it('retains a direct repository selection through the same canonical clone editor', () => {
    const selection = { serverId: 'home', machineId: 'devbox', source: { kind: 'repository' as const, selector: source.repository },
      materialization: { kind: 'clone' as const, destinationParentPath: '/clones', destinationDirectoryName: 'repo' } };
    const state = projectOpenChoiceStateFromDraft(selection, [], '/home/me');
    expect(resolveProjectOpenUseOptions(state).map(option => option.use)).toEqual(['clone']);
    expect(buildProjectOpenInput(buildProjectOpenDraft({ ...state, ref: 'feature' }), [])).toMatchObject({
      source: selection.source, ref: 'feature', materialization: selection.materialization });
  });
  it.each([
    { kind: 'copy_once' as const, contentPolicy: buildWorkspaceContentPolicy({ contentSelection: 'all_files', includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: ['.env.local'] }) },
    { kind: 'create_relationship' as const, mode: 'keep_synced' as const, flushBeforeCommit: true as const,
      contentPolicy: buildWorkspaceContentPolicy({ contentSelection: 'all_files', includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: ['.env.local'] }) },
    { kind: 'relationship' as const, relationshipId: 'existing-link', flushBeforeCommit: false },
    { kind: 'linked_workspace' as const },
  ])('preserves a retained $kind activation when another Open field changes', workspaceAction => {
    const from = checkout('other', 'mac', '/source');
    const retained = { serverId: 'home', machineId: 'devbox', source: { kind: 'source' as const,
      id: source.id, revision: source.revision, selector: source.repository, subdir: 'saved/default',
      checkout: { serverId: 'home', machineId: 'mac', workspaceId: from.id, rootPath: from.rootPath } },
      materialization: { kind: 'sync' as const, targetPath: '/target', workspaceAction }, subdir: 'packages/app' };
    const state = projectOpenChoiceStateFromDraft(retained, [from], '/home/me');
    const edited = buildProjectOpenDraft({ ...state, ref: 'feature', destination: '/new-target' });
    expect(buildProjectOpenInput(edited, [from])).toMatchObject({ ref: 'feature', subdir: 'packages/app',
      source: { subdir: 'saved/default' }, materialization: { kind: 'sync', targetPath: '/new-target', workspaceAction } });
    expect(retained.source.subdir).toBe('saved/default');
  });

  it('retains the canonical worktree mode and target while editing the displayed branch', () => {
    const retained = { serverId: 'home', machineId: 'devbox', source: { kind: 'folder' as const, path: '/repo' },
      materialization: { kind: 'worktree' as const, targetPath: '/elsewhere', checkout: {
        kind: 'git_worktree' as const, displayName: 'existing', baseRef: 'main', branchMode: 'existing' as const } } };
    const state = projectOpenChoiceStateFromDraft(retained, [], '/home/me');
    expect(buildProjectOpenInput(buildProjectOpenDraft({ ...state, branch: 'other-existing' }), [])).toMatchObject({
      materialization: { targetPath: '/elsewhere', checkout: { displayName: 'other-existing', branchMode: 'existing' } } });
  });
  it('allows partial authoring while the full Open owner enforces Home and Workspace match', () => {
    expect(OpenProjectDraftSelectionV1Schema.safeParse({ serverId: 'home', editing: { destination: 'typing' } }).success).toBe(true);
    const selection = { serverId: 'home', machineId: 'devbox', source: { kind: 'workspace' as const,
      workspaceId: 'selected', checkout: { serverId: 'other', machineId: 'devbox', workspaceId: 'different', rootPath: '/repo' } },
      materialization: { kind: 'attach' as const } };
    expect(OpenProjectDraftSelectionV1Schema.safeParse(selection).success).toBe(true);
    expect(OpenProjectInputV1Schema.safeParse(selection).success).toBe(false);
  });

  it('offers only a fresh clone where the machine has no checkout of the Source, never an existing checkout it lacks', () => {
    expect(
      resolveProjectOpenUseOptions(base).map((option) => option.use),
    ).toEqual(['clone']);
  });

  it('puts the checkout already on the machine first, then a worktree from it, then a clone and a copy from elsewhere', () => {
    const checkouts = [
      checkout('devbox-main', 'devbox', '/home/me/src/happier'),
      checkout('mac-main', 'mac', '/Users/me/code/happier'),
    ];
    const options = resolveProjectOpenUseOptions({ ...base, checkouts });
    expect(
      options.map((option) => [option.use, option.from?.id ?? null]),
    ).toEqual([
      ['existing', 'devbox-main'],
      ['worktree', 'devbox-main'],
      ['clone', null],
      ['copy', 'mac-main'],
    ]);
  });

  it('retains captured Source, unfinished fields and explicit leaf choices across remount', () => {
    const checkouts = [
      checkout('devbox-main', 'devbox', '/home/me/src/happier'),
    ];
    const state = { ...base, checkouts, ref: 'feature', use: 'worktree' as const,
      checkoutId: 'devbox-main', branch: '   ', destination: 'relative/' };
    const draft = buildProjectOpenDraft(state);
    expect(draft?.source).toMatchObject({ kind: 'source', id: source.id, revision: 3,
      selector: source.repository, defaultRef: 'v0.3' });
    expect(OpenProjectDraftSelectionV1Schema.safeParse(draft).success).toBe(true);
    const restored = projectOpenChoiceStateFromDraft(draft, checkouts, '/home/me');
    expect(restored).toMatchObject({ subject: { kind: 'source', source: { revision: 3 } },
      ref: 'feature', use: 'worktree', checkoutId: 'devbox-main', branch: '   ', destination: 'relative/' });
    expect(buildProjectOpenDraft(restored)).toEqual(draft);
    expect(buildProjectOpenInput(draft, checkouts)).toBeNull();
    const ready = buildProjectOpenDraft({ ...restored, branch: 'feat-pricing' });
    expect(buildProjectOpenInput(ready, checkouts)).toMatchObject({ source: { kind: 'source', id: source.id,
      revision: source.revision, selector: source.repository, defaultRef: 'v0.3', checkout: { workspaceId: 'devbox-main', serverId: 'home', machineId: 'devbox' } },
      materialization: { kind: 'worktree', checkout: { displayName: 'feat-pricing' } } });
    expect(OpenProjectInputV1Schema.safeParse(buildProjectOpenInput(ready, checkouts)).success).toBe(true);
    expect(buildProjectOpenInput(ready, [])).toBeNull();
    const unfinishedSubdir = buildProjectOpenDraft({ ...restored, branch: 'feat-pricing', subdir: '../typing' });
    expect(OpenProjectDraftSelectionV1Schema.safeParse(unfinishedSubdir).success).toBe(true);
    expect(projectOpenChoiceStateFromDraft(unfinishedSubdir, checkouts, null).subdir).toBe('../typing');
    expect(buildProjectOpenInput(unfinishedSubdir, checkouts)).toBeNull();
    const clone = buildProjectOpenDraft({ ...restored, machineId: 'other-machine', use: 'clone',
      destination: '/home/me/src/happier' });
    expect(buildProjectOpenInput(clone, checkouts)?.source).toMatchObject({ kind: 'source', revision: 3 });
    expect(buildProjectOpenInput({ ...clone, editing: { ...clone.editing, destination: 'still-typing' } }, checkouts)).toBeNull();
    expect(buildProjectOpenInput({ ...ready, editing: { ...ready.editing, branch: '   ' } }, checkouts)).toBeNull();
    const absent = projectOpenChoiceStateFromDraft(ready, [], null);
    expect(buildProjectOpenDraft(absent)).toEqual(ready);
    expect(buildProjectOpenDraft({ ...base, machineId: null, subject: null,
      use: 'clone', destination: '../typing' })).toMatchObject({ serverId: 'home', editing: { destination: '../typing' } });
  });

  it('suggests a destination clear of the checkouts it knows on that machine, without selecting it', () => {
    const checkouts = [
      checkout('devbox-main', 'devbox', '/home/me/src/happier'),
      checkout('devbox-two', 'devbox', '/home/me/src/happier-2/'),
      checkout('mac-main', 'mac', '/home/me/src/happier-3'),
    ];
    expect(suggestProjectOpenDestination(base)).toBe('/home/me/src/happier');
    // A known checkout on the chosen machine takes the name; one elsewhere does not.
    expect(suggestProjectOpenDestination({ ...base, checkouts })).toBe(
      '/home/me/src/happier-3',
    );
    expect(
      suggestProjectOpenDestination({ ...base, machineHomeDir: null }),
    ).toBe('');
  });

  it('starts on a valid way to open, and leaves the exact checkout to the person when several are here', () => {
    const older = { ...checkout('older', 'devbox', '/home/me/src/happier'), lastOpenedAtMs: 10 };
    const recent = { ...checkout('recent', 'devbox', '/home/me/src/happier-wt/fix'), lastOpenedAtMs: 20 };
    const checkouts = [older, recent];
    // Several candidates: the way is the existing checkout, but no adapter picks which one (plans 10 ID-1, 11 OPEN-4).
    const defaults = resolveProjectOpenDefaults({ ...base, checkouts });
    expect(defaults).toEqual({ use: 'existing' });
    const state = { ...base, checkouts, ...defaults };
    expect(buildProjectOpenInput(buildProjectOpenDraft(state), checkouts)).toBeNull();
    // The person's own choice stays, and a way with no checkout here starts on a clone.
    expect(resolveProjectOpenDefaults({ ...base, checkouts, use: 'worktree', checkoutId: 'older' })).toEqual({});
    expect(resolveProjectOpenDefaults(base)).toEqual({ use: 'clone' });
    expect(resolveProjectOpenDefaults({ ...base, machineId: null })).toEqual({});
    // Exactly one candidate is preselected, even after Where moved off a checkout named on another Machine.
    const only = checkout('only', 'devbox', '/home/me/src/happier');
    expect(resolveProjectOpenDefaults({ ...base, checkouts: [only], checkoutId: 'elsewhere' }))
      .toMatchObject({ use: 'existing', checkoutId: 'only', checkoutAddress: { workspaceId: 'only', machineId: 'devbox' } });
  });

  it.each([null, 'existing', 'worktree', 'copy'] as const)('captures the sole shown checkout in the executable draft (%s)', use => {
    const only = checkout('only', use === 'copy' ? 'mac' : 'devbox', '/home/me/src/happier');
    const state: ProjectOpenChoiceState = { ...base, checkouts: [only], use,
      branch: 'feature', destination: '/home/me/src/happier-copy' };
    const defaults = resolveProjectOpenDefaults(state);
    const address = { serverId: only.serverId, machineId: only.machineId, workspaceId: only.id, rootPath: only.rootPath };
    expect(defaults).toMatchObject({ checkoutId: only.id, checkoutAddress: address });
    const draft = buildProjectOpenDraft({ ...state, ...defaults });
    expect(draft.editing?.checkout).toEqual(address);
    expect(buildProjectOpenInput(draft, state.checkouts)).toMatchObject({ source: { kind: 'source', checkout: address },
      materialization: { kind: use === 'copy' ? 'sync' : use === 'worktree' ? 'worktree' : 'attach' } });
    const restored = projectOpenChoiceStateFromDraft(draft, state.checkouts, state.machineHomeDir);
    expect(resolveProjectOpenDefaults(restored)).toEqual({});
    expect(buildProjectOpenInput(draft, [])).toBeNull();
  });

  it('reads a clone with no destination yet as no destination, never the root "/"', () => {
    const draft = OpenProjectDraftSelectionV1Schema.parse({ serverId: 'home', machineId: 'devbox',
      materialization: { kind: 'clone', destinationParentPath: '', destinationDirectoryName: '' } });
    expect(projectOpenChoiceStateFromDraft(draft, [], '/home/me').destination).toBe('');
  });

  it('reports multiple Source checkouts without picking the shortest or crossing Homes', () => {
    const short = checkout('short', 'devbox', '/x');
    const long = checkout('long', 'devbox', '/home/me/projects/happier');
    const foreign = { ...checkout('foreign', 'devbox', '/foreign'), serverId: 'other' };
    const checkouts = [long, foreign, short];
    const option = resolveProjectOpenUseOptions({ ...base, checkouts })[0];
    expect(option?.from).toBeNull();
    expect(option?.candidates.map(ref => ref.id)).toEqual(['long', 'short']);
    expect(buildProjectOpenInput(buildProjectOpenDraft({ ...base, checkouts, use: 'existing' }), checkouts)).toBeNull();
    expect(resolveProjectOpenUseOptions({ ...base, checkouts, checkoutId: 'long' })[0]?.from?.id).toBe('long');
  });

  it('offers only the exact Workspace subject, never another row sharing its Project or repository', () => {
    const exact = { ...checkout('exact', 'mac', '/Users/me/happier'), projectKey: 'project' };
    const other = { ...checkout('other', 'devbox', '/x'), projectKey: 'project' };
    expect(resolveProjectOpenUseOptions({ ...base, subject: { kind: 'workspace', workspace: exact },
      checkouts: [other, exact] }).map(option => [option.use, option.from?.id])).toEqual([['copy', 'exact']]);
    expect(resolveProjectOpenUseOptions({ ...base, subject: { kind: 'workspace', workspace: exact },
      checkouts: [other] })).toEqual([]);
  });

  it('refuses an explicit checkout whose accepted address moved to another Machine', () => {
    const here = checkout('here', 'devbox', '/x');
    const draft = buildProjectOpenDraft({ ...base, checkouts: [here], use: 'existing', checkoutId: here.id });
    expect(buildProjectOpenInput(draft, [here])?.source).toMatchObject({ kind: 'source', id: source.id,
      checkout: { workspaceId: 'here', serverId: 'home', machineId: 'devbox' } });
    expect(buildProjectOpenInput(draft, [{ ...here, machineId: 'other' }])).toBeNull();
  });

  it('retains invalid raw folder edits without wiping Machine, ref or worktree intent', () => {
    const draft = buildProjectOpenDraft({ ...base, subject: { kind: 'folder', path: '/bad\0path' },
      use: 'worktree', branch: 'feature', ref: 'main' });
    expect(OpenProjectDraftSelectionV1Schema.safeParse(draft).success).toBe(true);
    const restored = projectOpenChoiceStateFromDraft(draft, [], null);
    expect(restored).toMatchObject({ machineId: 'devbox', ref: 'main', use: 'worktree',
      branch: 'feature', subject: { kind: 'folder', path: '/bad\0path' } });
    expect(buildProjectOpenInput(draft, [])).toBeNull();
    const ready = buildProjectOpenDraft({ ...restored, subject: { kind: 'folder', path: '/repo' } });
    expect(resolveProjectOpenUseOptions({ ...restored, subject: { kind: 'folder', path: '/repo' } })
      .some(option => option.use === 'worktree')).toBe(true);
    expect(buildProjectOpenInput(ready, [])).toMatchObject({ source: { kind: 'folder', path: '/repo' },
      materialization: { kind: 'worktree', checkout: { displayName: 'feature', baseRef: 'main' } } });
  });

  it('keeps an unresolved header directory as raw intent without selecting Source or Machine', () => {
    const state = projectOpenChoiceStateFromDraft({ serverId: 'home', editing: { folderPath: '/repo/nested' } }, [], null);
    expect(state).toMatchObject({ folderPath: '/repo/nested', machineId: null, subject: null });
    const draft = buildProjectOpenDraft({ ...state, branch: 'typing' });
    expect(draft.editing?.folderPath).toBe('/repo/nested');
    expect(draft.source).toBeUndefined();
    expect(draft.machineId).toBeUndefined();
    expect(buildProjectOpenInput(draft, [])).toBeNull();
    const selectedSource = buildProjectOpenDraft({ ...state, machineId: 'devbox',
      subject: { kind: 'source', source }, use: 'clone', destination: '/clones/happier' });
    expect(selectedSource.editing?.folderPath).toBe('/repo/nested');
    expect(buildProjectOpenInput(selectedSource, [])?.source.kind).toBe('source');
  });

  it('normalizes profile and legacy Home aliases for the request and exact checkout through the real profile owner', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    const scope = 'project-open-choices-alias';
    const profile = { id: 'choice-home-profile', serverIdentityId: 'srv_choice_canonical',
      legacyServerIds: ['choice-home-alias'], name: 'Choice Home', serverUrl: 'https://choice-home.example.test',
      source: 'manual', createdAt: 1, updatedAt: 1, lastUsedAt: 1 } satisfies ServerProfile;
    process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
    const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
    storage.set('server-state-v1', JSON.stringify({ activeServerId: profile.id, servers: { [profile.id]: profile } }));
    resetServerProfilesRuntimeForTests();
    try {
      expect(resolveServerProfileScopeIdForIdentifier('choice-home-alias')).toBe(profile.serverIdentityId);
      const ref = { ...checkout('chosen', 'devbox', '/chosen'), serverId: profile.id };
      const draft = buildProjectOpenDraft({ ...base, serverId: 'choice-home-alias', checkouts: [ref],
        checkoutId: ref.id, use: 'existing' });
      const input = buildProjectOpenInput(draft, [ref]);
      expect(input).toMatchObject({ serverId: profile.serverIdentityId, source: { kind: 'source',
        id: source.id, revision: 3, selector: source.repository, defaultRef: 'v0.3',
        checkout: { serverId: profile.serverIdentityId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath } } });
      expect(draft.serverId).toBe('choice-home-alias');
      expect(draft.editing?.checkout?.serverId).toBe(profile.id);
    } finally {
      if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
      else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
      resetServerProfilesRuntimeForTests();
    }
  });

  it('retains a selected Workspace address when its id names two roots on the same Machine', () => {
    const first = checkout('duplicate', 'devbox', '/one');
    const chosen = checkout('duplicate', 'devbox', '/two');
    const checkouts = [first, chosen];
    const draft = buildProjectOpenDraft({ ...base, subject: { kind: 'workspace', workspace: chosen },
      checkouts, use: 'existing' });
    expect(buildProjectOpenInput(draft, checkouts)?.source).toEqual({ kind: 'workspace', workspaceId: 'duplicate',
      checkout: { serverId: 'home', machineId: 'devbox', workspaceId: 'duplicate', rootPath: '/two' } });
    expect(projectOpenChoiceStateFromDraft(draft, checkouts, null).subject).toEqual({ kind: 'workspace', workspace: chosen });
    expect(buildProjectOpenInput({ ...draft, editing: undefined }, checkouts)).toBeNull();
    expect(buildProjectOpenInput({ ...draft, source: { kind: 'workspace', workspaceId: 'wrong' } }, checkouts)).toBeNull();
    const sourceDraft = { ...draft, source: { kind: 'source' as const, id: source.id,
      revision: source.revision, selector: source.repository } };
    const state = projectOpenChoiceStateFromDraft(sourceDraft, checkouts, null);
    expect(resolveProjectOpenUseOptions(state)[0]?.from).toEqual(chosen);
    expect(buildProjectOpenDraft(state).editing?.checkout?.rootPath).toBe('/two');
  });
});
