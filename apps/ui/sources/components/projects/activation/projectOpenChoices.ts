import { OpenProjectInputV1Schema, type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { OpenProjectDraftSelectionV1Schema, type OpenProjectDraftSelectionV1 } from '@happier-dev/protocol/projects/openProjectDraftV1';
import { normalizeProjectSourceSubdirV1, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { buildWorkspaceContentPolicy } from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefByAddress, resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';

export type ProjectOpenSubject =
  | Readonly<{ kind: 'source'; source: Pick<ProjectSourceV1, 'id' | 'revision' | 'repository' | 'defaultRef' | 'subdir'> }>
  | Readonly<{ kind: 'folder'; path: string }>
  | Readonly<{ kind: 'workspace'; workspace: Pick<WorkspaceRefV1, 'id' | 'serverId' | 'machineId' | 'rootPath'> }>;
export type ProjectOpenUse = 'existing' | 'worktree' | 'clone' | 'copy';
export type ProjectOpenChoiceState = Readonly<{
  serverId: string;
  machineId: string | null;
  machineHomeDir: string | null;
  subject: ProjectOpenSubject | null;
  ref: string | null;
  subdir?: string | null;
  /** Unresolved header directory intent is retained text, never a chosen Source. */
  folderPath?: string;
  use: ProjectOpenUse | null;
  branch: string;
  destination: string;
  /** An explicit checkout choice, never a shortest-path or repository-identity guess. */
  checkoutId?: string | null;
  checkoutAddress?: WorkspaceAddressV1 | null;
  checkouts: readonly WorkspaceRefV1[];
}>;
export type ProjectOpenUseOption = Readonly<{
  use: ProjectOpenUse;
  from: WorkspaceRefV1 | null;
  /** Multiple candidates require an explicit exact checkout selection. */
  candidates: readonly WorkspaceRefV1[];
}>;

/**
 * A nonexecuting suggestion: `~/src/<name>`, or the first `<name>-N` no known checkout on that
 * machine already uses. Known checkout rows cannot prove filesystem availability.
 */
export function suggestProjectOpenDestination(
  state: Pick<ProjectOpenChoiceState, 'machineId' | 'machineHomeDir' | 'subject' | 'checkouts'>,
): string {
  if (!state.subject || !state.machineHomeDir) return '';
  const name = state.subject.kind === 'source'
    ? state.subject.source.repository.repository.nameWithOwner.split('/').pop()
    : state.subject.kind === 'workspace'
      ? state.subject.workspace.rootPath.split(/[\\/]/u).filter(Boolean).pop() : null;
  if (!name) return '';
  const comparable = (path: string) => path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const taken = new Set(state.checkouts.filter(ref => ref.machineId === state.machineId).map(ref => comparable(ref.rootPath)));
  const parent = `${state.machineHomeDir.replace(/[\\/]+$/u, '')}/src`;
  let candidate = `${parent}/${name}`;
  for (let suffix = 2; taken.has(comparable(candidate)); suffix += 1) candidate = `${parent}/${name}-${suffix}`;
  return candidate;
}

export function resolveProjectOpenUseOptions(state: ProjectOpenChoiceState): readonly ProjectOpenUseOption[] {
  if (!state.subject || !state.machineId) return [];
  if (state.subject.kind === 'folder') return [
    { use: 'existing', from: null, candidates: [] },
    // A canonical SCM entrance may carry an explicitly chosen worktree intent.
    ...(state.use === 'worktree' ? [{ use: 'worktree' as const, from: null, candidates: [] }] : []),
  ];
  const subject = state.subject;
  const home = resolveServerProfileScopeIdForIdentifier(state.serverId);
  let candidates: readonly WorkspaceRefV1[];
  if (subject.kind === 'workspace') {
    const result = resolveWorkspaceRefByAddress(state.checkouts, {
      serverId: subject.workspace.serverId, workspaceId: subject.workspace.id,
      machineId: subject.workspace.machineId, rootPath: subject.workspace.rootPath,
    });
    candidates = result.kind === 'resolved' && resolveServerProfileScopeIdForIdentifier(result.ref.serverId) === home
      ? [result.ref] : result.kind === 'ambiguous'
        ? result.candidates.filter(ref => resolveServerProfileScopeIdForIdentifier(ref.serverId) === home) : [];
  } else {
    // Source provenance offers candidates, not an accepted Project anchor or exact checkout.
    candidates = state.checkouts.filter(ref => resolveServerProfileScopeIdForIdentifier(ref.serverId) === home
      && ref.source?.sourceId === subject.source.id);
  }
  const option = (use: ProjectOpenUse, refs: readonly WorkspaceRefV1[]): ProjectOpenUseOption => {
    const selected = state.checkoutAddress && state.checkoutAddress.workspaceId === state.checkoutId
      ? resolveWorkspaceRefByAddress(refs, state.checkoutAddress)
      : state.checkoutId ? resolveWorkspaceRefById(refs, state.checkoutId, state.serverId) : null;
    return { use, candidates: refs, from: selected?.kind === 'resolved' ? selected.ref
      : !state.checkoutId && refs.length === 1 ? refs[0]! : null };
  };
  const here = candidates.filter(ref => ref.machineId === state.machineId);
  const elsewhere = candidates.filter(ref => ref.machineId !== state.machineId);
  return [
    ...(here.length ? [option('existing', here), option('worktree', here)] : []),
    ...(subject.kind === 'source' ? [{ use: 'clone' as const, from: null, candidates: [] }] : []),
    ...(elsewhere.length ? [option('copy', elsewhere)] : []),
  ];
}

function splitDestination(path: string): { parent: string; name: string } | null {
  const trimmed = path.trim().replace(/[\\/]+$/u, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (at < 0 || at === trimmed.length - 1) return null;
  return { parent: at === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, at), name: trimmed.slice(at + 1) };
}

/** Retain every unfinished choice. Building this document executes nothing. */
export function buildProjectOpenDraft(state: ProjectOpenChoiceState): OpenProjectDraftSelectionV1 {
  const subject = state.subject;
  const option = resolveProjectOpenUseOptions(state).find(candidate => candidate.use === state.use);
  const exact = option?.from && (subject?.kind === 'workspace' || state.checkoutId === option.from.id)
    ? workspaceAddressFromRefV1(option.from)
    : subject?.kind === 'workspace' ? { serverId: subject.workspace.serverId, workspaceId: subject.workspace.id,
      machineId: subject.workspace.machineId, rootPath: subject.workspace.rootPath }
      : state.checkoutAddress?.workspaceId === state.checkoutId ? state.checkoutAddress : undefined;
  const source = subject?.kind === 'source' ? {
    kind: 'source' as const, id: subject.source.id, revision: subject.source.revision, selector: subject.source.repository,
    ...(subject.source.defaultRef ? { defaultRef: subject.source.defaultRef } : {}),
    ...(subject.source.subdir ? { subdir: subject.source.subdir } : {}),
  } : subject?.kind === 'workspace' ? { kind: 'workspace' as const, workspaceId: subject.workspace.id }
    : subject?.kind === 'folder' ? { kind: 'folder' as const, path:
      OpenProjectInputV1Schema.shape.source.options[1].shape.path.safeParse(subject.path).success ? subject.path : '' } : undefined;
  let materialization: OpenProjectDraftSelectionV1['materialization'];
  switch (state.use) {
    case 'existing': materialization = { kind: 'attach' }; break;
    case 'worktree': {
      const candidate = { kind: 'worktree' as const, checkout: { kind: 'git_worktree' as const,
        displayName: state.branch.trim(), baseRef: state.ref?.trim() || null, branchMode: 'new' as const } };
      const parsed = OpenProjectDraftSelectionV1Schema.shape.materialization.safeParse(candidate);
      materialization = parsed.success ? candidate : { kind: 'worktree', checkout: {
        kind: 'git_worktree', displayName: '', baseRef: null, branchMode: 'new' } };
      break;
    }
    case 'clone': {
      const destination = splitDestination(state.destination);
      const candidate = { kind: 'clone' as const, destinationParentPath: destination?.parent ?? '',
        destinationDirectoryName: destination?.name ?? '' };
      const parsed = OpenProjectDraftSelectionV1Schema.shape.materialization.safeParse(candidate);
      materialization = parsed.success ? candidate : { kind: 'clone', destinationParentPath: '', destinationDirectoryName: '' };
      break;
    }
    case 'copy': {
      const candidate = { kind: 'sync' as const, targetPath: state.destination.trim(),
        workspaceAction: { kind: 'copy_once' as const,
          contentPolicy: buildWorkspaceContentPolicy({ includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [] }) } };
      const parsed = OpenProjectDraftSelectionV1Schema.shape.materialization.safeParse(candidate);
      materialization = parsed.success ? candidate : { ...candidate, targetPath: '' };
      break;
    }
  }
  const subdir = state.subdir?.trim();
  const parsedSubdir = OpenProjectInputV1Schema.shape.subdir.safeParse(subdir || undefined);
  const parsedRef = OpenProjectInputV1Schema.shape.ref.safeParse(state.ref?.trim() || undefined);
  return {
    serverId: state.serverId, ...(state.machineId ? { machineId: state.machineId } : {}),
    ...(source ? { source } : {}), ...(parsedRef.success && parsedRef.data ? { ref: parsedRef.data } : {}),
    ...(materialization ? { materialization } : {}),
    ...(parsedSubdir.success && parsedSubdir.data ? { subdir: parsedSubdir.data } : {}),
    editing: { branch: state.branch, destination: state.destination,
      ...(state.ref !== null ? { ref: state.ref } : {}),
      ...(state.subdir != null ? { subdir: state.subdir } : {}), ...(exact ? { checkout: exact } : {}),
      ...(subject?.kind === 'folder' ? { folderPath: subject.path }
        : state.folderPath !== undefined ? { folderPath: state.folderPath } : {}) },
  };
}

/** Project retained editing choices to a strict executable Open request. */
export function buildProjectOpenInput(selection: OpenProjectDraftSelectionV1, checkouts: readonly WorkspaceRefV1[]): OpenProjectInputV1 | null {
  const { editing, ...input } = selection;
  const needsCheckout = selection.source?.kind === 'workspace'
    || selection.source?.kind === 'source' && selection.materialization?.kind !== 'clone';
  const capturedCheckout = selection.source?.kind === 'source' || selection.source?.kind === 'workspace'
    ? selection.source.checkout : undefined;
  const selectedCheckout = selection.materialization?.kind === 'clone' && selection.source?.kind === 'source'
    ? undefined : editing?.checkout ?? capturedCheckout;
  if (needsCheckout && !selectedCheckout) return null;
  let checkout: WorkspaceAddressV1 | undefined;
  if (selectedCheckout) {
    const resolved = resolveWorkspaceRefByAddress(checkouts, selectedCheckout);
    if (resolved.kind !== 'resolved') return null;
    checkout = { ...selectedCheckout, serverId: resolveServerProfileScopeIdForIdentifier(resolved.ref.serverId) };
  }
  if (checkout && (resolveServerProfileScopeIdForIdentifier(checkout.serverId)
    !== resolveServerProfileScopeIdForIdentifier(selection.serverId)
    || (selection.materialization?.kind !== 'sync' && checkout.machineId !== selection.machineId))) return null;
  let materialization = input.materialization;
  // Retained raw text is the displayed editing authority, not an older normalized sibling.
  if (materialization?.kind === 'clone' && editing?.destination !== undefined) {
    const destination = splitDestination(editing.destination);
    if (!destination) return null;
    materialization = { ...materialization, destinationParentPath: destination.parent, destinationDirectoryName: destination.name };
  } else if (materialization?.kind === 'worktree' && editing?.branch !== undefined) {
    materialization = { ...materialization, checkout: { ...materialization.checkout, displayName: editing.branch.trim(),
      ...(editing.ref !== undefined ? { baseRef: editing.ref.trim() || null } : {}) } };
  } else if (materialization?.kind === 'sync' && editing?.destination !== undefined) {
    materialization = { ...materialization, targetPath: editing.destination.trim() };
  }
  const capturedSource = selection.source?.kind === 'source' ? {
    kind: 'source' as const, id: selection.source.id, revision: selection.source.revision,
    selector: selection.source.selector,
    ...(selection.source.defaultRef ? { defaultRef: selection.source.defaultRef } : {}),
    ...(selection.source.subdir ? { subdir: selection.source.subdir } : {}),
    ...(needsCheckout && checkout ? { checkout } : {}),
  } : undefined;
  const parsed = OpenProjectInputV1Schema.safeParse({ ...input,
    serverId: resolveServerProfileScopeIdForIdentifier(selection.serverId),
    materialization,
    ...(editing?.ref !== undefined ? { ref: editing.ref.trim() || undefined } : {}),
    ...(editing?.subdir !== undefined ? { subdir: editing.subdir.trim() || undefined } : {}),
    ...(input.source?.kind === 'folder' && editing?.folderPath !== undefined
      ? { source: { ...input.source, path: editing.folderPath } } : {}),
    ...(selection.source?.kind === 'workspace' ? { source: { ...selection.source, checkout } } : {}),
    ...(capturedSource ? { source: capturedSource } : {}) });
  return parsed.success ? parsed.data : null;
}

/** Hydration uses captured values, not refreshed mutable Source catalog defaults. */
export function projectOpenChoiceStateFromDraft(
  selection: OpenProjectDraftSelectionV1,
  checkouts: readonly WorkspaceRefV1[],
  machineHomeDir: string | null,
): ProjectOpenChoiceState {
  const source = selection.source;
  const editing = selection.editing;
  const checkout = editing?.checkout ?? (source?.kind === 'source' || source?.kind === 'workspace' ? source.checkout : undefined);
  let subject: ProjectOpenSubject | null = null;
  if (source?.kind === 'source') subject = { kind: 'source', source: {
    id: source.id, revision: source.revision, repository: source.selector,
    ...(source.defaultRef ? { defaultRef: source.defaultRef } : {}), subdir: normalizeProjectSourceSubdirV1(source.subdir),
  } };
  else if (source?.kind === 'folder') subject = { kind: 'folder', path: editing?.folderPath ?? source.path };
  else if (source?.kind === 'workspace') {
    const resolved = checkout ? resolveWorkspaceRefByAddress(checkouts, checkout)
      : resolveWorkspaceRefById(checkouts, source.workspaceId, selection.serverId);
    if (resolved.kind === 'resolved') subject = { kind: 'workspace', workspace: resolved.ref };
    else if (checkout) subject = { kind: 'workspace', workspace: {
      id: checkout.workspaceId, serverId: checkout.serverId,
      machineId: checkout.machineId, rootPath: checkout.rootPath,
    } };
  }
  const materialization = selection.materialization;
  return { serverId: selection.serverId, machineId: selection.machineId || null, machineHomeDir, subject,
    checkouts, checkoutId: checkout?.workspaceId ?? null, checkoutAddress: checkout ?? null,
    ref: editing?.ref ?? selection.ref ?? null, subdir: editing?.subdir ?? selection.subdir ?? null,
    folderPath: editing?.folderPath,
    use: !materialization ? null : materialization.kind === 'attach' ? 'existing' : materialization.kind === 'sync' ? 'copy' : materialization.kind,
    branch: editing?.branch ?? (materialization?.kind === 'worktree' ? materialization.checkout.displayName : ''),
    destination: editing?.destination ?? (materialization?.kind === 'clone'
      ? `${materialization.destinationParentPath}/${materialization.destinationDirectoryName}`
      : materialization?.kind === 'sync' ? materialization.targetPath : ''),
  };
}
