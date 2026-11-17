import {
  editProjectManifestDocument,
  readProjectManifestDocument,
  type ProjectManifestDocument,
  type ProjectManifestDocumentEdit,
  type ProjectManifestFileSnapshot,
  type ProjectManifestUpdateResult,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import {
  ProjectDevcontainerSelectionV1Schema,
  ProjectToolchainSelectionV1Schema,
  ProjectNativeRefV1Schema,
  ProjectWorktreePortsV1Schema,
  ProjectServiceRuntimeV1Schema,
  type ProjectWorktreePortsV1,
  type ProjectServiceRuntimeV1,
  type ProjectDevcontainerSelectionV1,
  type ProjectToolchainSelectionV1,
  type ProjectNativeRefV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectDefinitionWorkspace } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { EnvVarRequirementSchema, type EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import {
  readWorkspaceFileEditorDraft,
  type WorkspaceFileEditorDraft,
} from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft';

// The qualified workspace remains captured by the editor; focus never selects a write target.
export type ProjectManifestEditorWorkspace = ProjectDefinitionWorkspace;
export type PersonalProjectManifestEditorBasis = Readonly<{ kind: 'personal'; revision: number | 'absent' }>;
export type ProjectManifestEditorDefinition = ProjectManifestFileSnapshot | Readonly<{
  basis: PersonalProjectManifestEditorBasis; document: ProjectManifestDocument | null;
}>;
type ProjectManifestEditorBasis = ProjectManifestEditorDefinition['basis'];
export type PersonalProjectManifestEditorUpdateResult =
  | Readonly<{ status: 'saved'; basis: PersonalProjectManifestEditorBasis; document: Extract<ProjectManifestDocument, { status: 'valid' }> }>
  | Readonly<{ status: 'conflict'; current: ProjectManifestEditorDefinition }>
  | Readonly<{ status: 'refused'; code: string; message?: string }>;
type EditorUpdateResult = ProjectManifestUpdateResult | PersonalProjectManifestEditorUpdateResult;
export type ProjectManifestEditorActions = Readonly<{
  update: (
    input: Readonly<{
      workspace: ProjectManifestEditorWorkspace;
      expectedBasis: ProjectManifestFileSnapshot['basis'];
      bytes: string;
    }>,
  ) => Promise<ProjectManifestUpdateResult>;
}>;
export type PersonalProjectManifestEditorActions = Readonly<{
  update(input: Readonly<{ workspace: ProjectManifestEditorWorkspace; expectedRevision: number | 'absent'; bytes: string }>): Promise<PersonalProjectManifestEditorUpdateResult>;
}>;
export type ProjectManifestEditorSnapshot = Readonly<{
  draft: ProjectManifestDocument;
  mode: 'form' | 'raw';
  formEnabled: boolean;
  dirty: boolean;
  saving: boolean;
  conflict: ProjectManifestEditorDefinition | null;
  error: Readonly<{ code: string; message?: string }> | null;
}>;

type RetainedManifestDraft = Readonly<{
  basis: ProjectManifestEditorBasis;
  originalText: string | null;
  text: string;
}>;
// Back unmounts this editor. Retain only its dirty project-manifest draft, qualified
// by Account, checkout and Personal Project row; file-pane drafts remain owned by persisted pane state.
const retainedManifestDrafts = new Map<string, RetainedManifestDraft>();
const creationBytes = '{\n  "version": 1\n}\n';
function bytesOf(definition: ProjectManifestEditorDefinition): string {
  return definition.document?.bytes ?? '';
}
function sameBasis(
  a: ProjectManifestEditorBasis,
  b: ProjectManifestEditorBasis,
): boolean {
  if (a.kind === 'personal') return b.kind === 'personal' && a.revision === b.revision;
  return a.kind === b.kind && (a.kind === 'absent' || b.kind === 'present' && a.hash === b.hash);
}

export function createProjectManifestEditorModel(
  input: Readonly<{
    workspace: ProjectManifestEditorWorkspace;
    expectedAccountId: string;
    inheritedRequirements?: readonly EnvVarRequirement[];
    persistedDraft?: WorkspaceFileEditorDraft | null;
    persistDraft?: (draft: WorkspaceFileEditorDraft | null) => void;
  }> & (Readonly<{ target?: 'repository'; definition: ProjectManifestFileSnapshot; actions: ProjectManifestEditorActions }>
    | Readonly<{ target: 'personal'; projectRef: QualifiedProjectKeyV1; definition: Extract<ProjectManifestEditorDefinition, { basis: PersonalProjectManifestEditorBasis }>;
        actions: PersonalProjectManifestEditorActions }>),
) {
  const draftKey = JSON.stringify([input.expectedAccountId, buildWorkspaceCacheKey(input.workspace), input.target ?? 'repository',
    ...(input.target === 'personal' ? [input.projectRef.serverId, input.projectRef.projectKey] : [])]);
  const cached = retainedManifestDrafts.get(draftKey);
  const persisted = input.target === 'personal' ? null : readWorkspaceFileEditorDraft(input.persistedDraft, input.expectedAccountId);
  const restored = cached ?? (persisted?.isEditingFile ? {
    basis: persisted.editorOriginalHash === null
      ? { kind: 'absent' as const }
      : { kind: 'present' as const, hash: persisted.editorOriginalHash },
    originalText: null,
    text: persisted.editorText,
  } : null);
  let basis = restored?.basis ?? input.definition.basis;
  let originalText = restored?.originalText ?? (sameBasis(basis, input.definition.basis) ? bytesOf(input.definition) : null);
  let current = input.definition;
  const draft = readProjectManifestDocument(
    restored?.text ?? input.definition.document?.bytes ?? creationBytes,
  );
  let snapshot: ProjectManifestEditorSnapshot = {
    draft,
    mode: draft.status === 'valid' ? 'form' : 'raw',
    formEnabled: draft.status === 'valid',
    dirty:
      input.definition.basis.kind === 'absent' ||
      draft.bytes !== originalText,
    saving: false,
    conflict:
      restored && !sameBasis(basis, current.basis) ? current : null,
    error: null,
  };
  const listeners = new Set<() => void>();
  function publish(next: ProjectManifestEditorSnapshot) {
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function persist() {
    if (snapshot.dirty) retainedManifestDrafts.set(draftKey, { basis, originalText, text: snapshot.draft.bytes });
    else retainedManifestDrafts.delete(draftKey);
    // Workspace file drafts carry file hashes. Personal drafts remain under this editor's row-revision owner.
    if (basis.kind === 'personal') return;
    const value: WorkspaceFileEditorDraft | null = snapshot.dirty
      ? {
          accountId: input.expectedAccountId,
          isEditingFile: true,
          editorOriginalHash:
            basis.kind === 'present' ? basis.hash : null,
          editorText: snapshot.draft.bytes,
        }
      : null;
    input.persistDraft?.(value);
  }
  function replaceDraft(next: ProjectManifestDocument) {
    if (
      next.bytes === snapshot.draft.bytes &&
      next.status === snapshot.draft.status
    )
      return;
    publish({
      ...snapshot,
      draft: next,
      formEnabled: next.status === 'valid',
      mode: next.status === 'invalid' ? 'raw' : snapshot.mode,
      dirty: basis.kind === 'absent' || next.bytes !== originalText,
      error: null,
    });
    persist();
  }
  function edit(edits: readonly ProjectManifestDocumentEdit[]) {
    if (!snapshot.formEnabled) return false;
    replaceDraft(editProjectManifestDocument(snapshot.draft, edits));
    return snapshot.draft.status === 'valid';
  }
  const getSnapshot = (): ProjectManifestEditorSnapshot => snapshot;
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setRaw(bytes: string) {
      if (bytes !== snapshot.draft.bytes)
        replaceDraft(readProjectManifestDocument(bytes));
    },
    setMode(mode: 'form' | 'raw') {
      if (mode === 'form' && !snapshot.formEnabled) return false;
      if (mode !== snapshot.mode) publish({ ...snapshot, mode });
      return true;
    },
    edit,
    setWorktreePorts(value: ProjectWorktreePortsV1 | undefined) {
      if (value === undefined) return edit([{ kind: 'remove', path: ['worktreePorts'] }]);
      const parsed = ProjectWorktreePortsV1Schema.safeParse(value);
      return parsed.success && edit([{ kind: 'set', path: ['worktreePorts'], value: parsed.data }]);
    },
    setServiceRuntime(name: string, value: ProjectServiceRuntimeV1 | undefined) {
      if (snapshot.draft.status !== 'valid' || !Object.hasOwn(snapshot.draft.manifest.services ?? {}, name)) return false;
      if (value === undefined) return edit([{ kind: 'remove', path: ['services', name, 'runtime'] }]);
      const parsed = ProjectServiceRuntimeV1Schema.safeParse(value);
      return parsed.success && edit([{ kind: 'set', path: ['services', name, 'runtime'], value: parsed.data }]);
    },
    /** Preserve existing classifications; imported examples contribute names, never values. */
    importEnvironmentRequirements(requirements: readonly unknown[], inherited: readonly EnvVarRequirement[] = input.inheritedRequirements ?? []) {
      if (snapshot.draft.status !== 'valid') return false;
      const parsed = requirements.map(requirement => EnvVarRequirementSchema.safeParse(requirement));
      if (parsed.some(requirement => !requirement.success)) return false;
      const existing = snapshot.draft.manifest.environmentVariables ?? [];
      const names = new Set([...inherited, ...existing].map(requirement => requirement.name));
      const additions = parsed.flatMap(requirement => {
        if (!requirement.success || names.has(requirement.data.name)) return [];
        names.add(requirement.data.name);
        return [requirement.data];
      });
      return additions.length === 0 || edit([{ kind: 'set', path: ['environmentVariables'], value: [...existing, ...additions] }]);
    },
    importNative(
      selection: Readonly<{
        usage: 'script' | 'service' | 'setup';
        name?: string;
        source: ProjectNativeRefV1;
      }>,
    ) {
      if (snapshot.draft.status !== 'valid') return false;
      const parsed = ProjectNativeRefV1Schema.safeParse(selection.source);
      if (!parsed.success) return false;
      if (selection.usage === 'setup') {
        const index = snapshot.draft.manifest.workspace?.setup?.length ?? 0;
        return edit([
          {
            kind: 'set',
            path: ['workspace', 'setup', index],
            value: parsed.data,
          },
        ]);
      }
      const collection = selection.usage === 'script' ? 'scripts' : 'services';
      const name = selection.name;
      if (
        !name ||
        Object.hasOwn(snapshot.draft.manifest[collection] ?? {}, name)
      )
        return false;
      return edit([
        {
          kind: 'set',
          path: [collection, name],
          value: { source: parsed.data },
        },
      ]);
    },
    importToolchain(selection: ProjectToolchainSelectionV1) {
      const parsed = ProjectToolchainSelectionV1Schema.safeParse(selection);
      return (
        parsed.success &&
        edit([{ kind: 'set', path: ['toolchain'], value: parsed.data }])
      );
    },
    removeDeclaration(collection: 'scripts' | 'services', name: string) {
      return edit([{ kind: 'remove', path: [collection, name] }]);
    },
    reorderDeclarations(
      collection: 'scripts' | 'services',
      keys: readonly string[],
    ) {
      return edit([{ kind: 'reorder', path: [collection], keys }]);
    },
    /** Renames in place: the declaration keeps its position and every field it carries, known or not. */
    renameDeclaration(
      collection: 'scripts' | 'services',
      from: string,
      to: string,
    ) {
      if (snapshot.draft.status !== 'valid') return false;
      const declarations = snapshot.draft.manifest[collection] ?? {};
      const name = to.trim();
      if (
        !name ||
        name === from ||
        !Object.hasOwn(declarations, from) ||
        Object.hasOwn(declarations, name)
      )
        return false;
      const original = snapshot.draft.original as Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
      const keys = Object.keys(declarations).map((key) =>
        key === from ? name : key,
      );
      return edit([
        {
          kind: 'set',
          path: [collection, name],
          value: original[collection]?.[from],
        },
        { kind: 'remove', path: [collection, from] },
        { kind: 'reorder', path: [collection], keys },
      ]);
    },
    removeSetupStep(index: number) {
      return edit([{ kind: 'remove', path: ['workspace', 'setup', index] }]);
    },
    /** `order` lists the current step positions in their new order. */
    reorderSetupSteps(order: readonly number[]) {
      return edit([
        { kind: 'reorder', path: ['workspace', 'setup'], keys: order },
      ]);
    },
    /** The Devcontainer namespace is its own field, independent of the toolchain environment. */
    selectDevcontainer(selection: ProjectDevcontainerSelectionV1 | null) {
      if (selection === null)
        return edit([{ kind: 'remove', path: ['devcontainer'] }]);
      const parsed = ProjectDevcontainerSelectionV1Schema.safeParse(selection);
      return (
        parsed.success &&
        edit([{ kind: 'set', path: ['devcontainer'], value: parsed.data }])
      );
    },
    receiveDefinition(definition: ProjectManifestEditorDefinition) {
      current = definition;
      if (sameBasis(basis, definition.basis)) return;
      if (snapshot.dirty || snapshot.saving)
        publish({ ...snapshot, conflict: definition });
      else {
        basis = definition.basis;
        originalText = bytesOf(definition);
        const next = readProjectManifestDocument(
          definition.document?.bytes ?? creationBytes,
        );
        publish({
          ...snapshot,
          draft: next,
          formEnabled: next.status === 'valid',
          mode: next.status === 'valid' ? snapshot.mode : 'raw',
          dirty: definition.document === null,
          conflict: null,
          error: null,
        });
      }
    },
    reviewCurrentBasis() {
      if (!snapshot.conflict) return;
      current = snapshot.conflict;
      basis = current.basis;
      originalText = bytesOf(current);
      publish({
        ...snapshot,
        conflict: null,
        dirty:
          basis.kind === 'absent' ||
          snapshot.draft.bytes !== originalText,
        error: null,
      });
      persist();
    },
    reloadCurrent() {
      current = snapshot.conflict ?? current;
      basis = current.basis;
      originalText = bytesOf(current);
      const next = readProjectManifestDocument(
        current.document?.bytes ?? creationBytes,
      );
      publish({
        ...snapshot,
        draft: next,
        formEnabled: next.status === 'valid',
        mode: next.status === 'valid' ? snapshot.mode : 'raw',
        dirty: current.document === null,
        conflict: null,
        error: null,
      });
      persist();
    },
    async save(): Promise<EditorUpdateResult | null> {
      if (
        !snapshot.formEnabled ||
        snapshot.saving ||
        snapshot.conflict ||
        !snapshot.dirty
      )
        return null;
      const bytes = snapshot.draft.bytes;
      const expectedBasis = basis;
      publish({ ...snapshot, saving: true, error: null });
      try {
        let result: EditorUpdateResult;
        if (input.target === 'personal') {
          if (expectedBasis.kind !== 'personal') throw new Error('Personal editor requires its row revision');
          result = await input.actions.update({ workspace: input.workspace, expectedRevision: expectedBasis.revision, bytes });
        } else {
          if (expectedBasis.kind === 'personal') throw new Error('Repository editor requires its file basis');
          result = await input.actions.update({ workspace: input.workspace, expectedBasis, bytes });
        }
        if (result.status === 'saved') {
          basis = result.basis;
          originalText = result.document.bytes;
          // An observed outside edit during the request remains a real conflict.
          const outsideEdit = getSnapshot().conflict;
          const conflict =
            outsideEdit && !sameBasis(outsideEdit.basis, result.basis)
              ? outsideEdit
              : null;
          current = conflict ?? (result.basis.kind === 'personal'
            ? { basis: result.basis, document: result.document }
            : { basis: result.basis, document: result.document });
          const draft =
            snapshot.draft.bytes === bytes ? result.document : snapshot.draft;
          publish({
            ...snapshot,
            draft,
            formEnabled: draft.status === 'valid',
            dirty: draft.bytes !== result.document.bytes,
            saving: false,
            conflict,
            error: null,
          });
          persist();
        } else if (result.status === 'conflict') {
          current = result.current;
          publish({ ...snapshot, saving: false, conflict: result.current });
        } else {
          publish({
            ...snapshot,
            saving: false,
            error: {
              code: result.code,
              ...(result.message ? { message: result.message } : {}),
            },
          });
        }
        return result;
      } catch (error) {
        const code =
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'request_failed';
        publish({
          ...snapshot,
          saving: false,
          error: {
            code,
            ...(error instanceof Error ? { message: error.message } : {}),
          },
        });
        return null;
      }
    },
  };
}

export type ProjectManifestEditorModel = ReturnType<
  typeof createProjectManifestEditorModel
>;
