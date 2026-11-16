import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  SKILL_ACTION_OUTPUT_SCHEMAS_V1,
  type SkillLibraryActionInputByIdV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import {
  SkillReadResultV1Schema,
  type SkillReadResultV1,
} from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { useRegistryUpdateCheck } from '@/registries/useRegistryUpdateCheck';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { HappyError } from '@/utils/errors/errors';

import { readSkillText } from './skillFileContent';
import { readSkillActionRefusal } from '../skillActionResult';
import { acknowledgeSkillActionResult } from '../add/skillInstall';

export type SkillDetailStatus =
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'not_found';
export type SkillChange = Omit<
  SkillLibraryActionInputByIdV1['skills.update'],
  'skillId' | 'expectedRevision'
>;
export type SkillChangeResult =
  | Readonly<{ ok: true; revision: string }>
  | Readonly<{ ok: false; code: string }>;

/**
 * One skill as the detail page reads and changes it, entirely through the `skills.*` Actions (C28: no
 * UI library writes): `skills.read` for its content, `skills.update` with the read revision as the CAS,
 * `skills.delete`/`skills.duplicate`, `artifact.folder.set` for its folder and P4's
 * `registries.updates.check`. It re-reads when the library reports a newer revision, unless the page
 * holds an unsaved edit (the edit then meets the newer revision as a conflict).
 */
export function useSkillDetail(skillId: string | null) {
  const library = useSkillsLibrary();
  const serverId = library.scope?.serverId ?? null;
  const { execute, ready, isCurrent } = useMountedActionExecution(serverId);
  const folders = usePromptLibraryCatalogValue('folders');
  const listItem = React.useMemo(
    () =>
      skillId
        ? (library.items.find((item) => item.skillId === skillId) ?? null)
        : null,
    [library.items, skillId],
  );
  const [state, setState] = React.useState<
    Readonly<{
      skillId: string | null;
      read: SkillReadResultV1 | null;
      status: SkillDetailStatus;
      errorCode: string | null;
    }>
  >({ skillId, read: null, status: 'loading', errorCode: null });
  const [attempt, setAttempt] = React.useState(0);
  const { check, checkNow } = useRegistryUpdateCheck({ scopeKey: JSON.stringify([library.scope, skillId]),
    execute, isCurrent, kind: 'skill', keys: skillId ? [skillId] : [], retry: library.retry });
  /** The page holds an edit the library has not acknowledged: a newer revision must not replace it. */
  const holdRef = React.useRef(false);
  const readRef = React.useRef<SkillReadResultV1 | null>(null);
  const current =
    state.skillId === skillId
      ? state
      : { skillId, read: null, status: 'loading' as const, errorCode: null };
  readRef.current = current.read;

  // A newer revision elsewhere (another device, an agent, the update tracker) refreshes the page.
  const newerKnown =
    listItem !== null &&
    current.read !== null &&
    listItem.revision !== current.read.revision;
  const readKey = `${attempt}:${newerKnown && !holdRef.current ? listItem?.revision : ''}`;

  React.useEffect(() => {
    if (!skillId || !ready) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await execute(
          'skills.read',
          { skillId },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const refusal = readSkillActionRefusal(result);
        if (refusal) {
          setState((prev) => ({
            skillId,
            read: prev.skillId === skillId ? prev.read : null,
            status: refusal === 'not_found' ? 'not_found' : 'unavailable',
            errorCode: refusal,
          }));
          return;
        }
        const read = SkillReadResultV1Schema.parse(
          result.ok ? result.result : null,
        );
        setState({ skillId, read, status: 'ready', errorCode: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        const code =
          error &&
          typeof error === 'object' &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'library_unavailable';
        setState((prev) => ({
          skillId,
          read: prev.skillId === skillId ? prev.read : null,
          status: 'unavailable',
          errorCode: code,
        }));
      }
    })();
    return () => controller.abort();
  }, [execute, ready, skillId, readKey]);

  const retry = React.useCallback(() => {
    library.retry();
    setAttempt((value) => value + 1);
  }, [library]);

  const setHold = React.useCallback((hold: boolean) => {
    holdRef.current = hold;
  }, []);

  /** One `skills.update` against the revision the page last read; a newer one answers `revision_conflict`. */
  const update = React.useCallback(
    async (change: SkillChange): Promise<SkillChangeResult> => {
      const read = readRef.current;
      if (!skillId || !read) return { ok: false, code: 'not_ready' };
      try {
        const result = await execute('skills.update', {
          skillId,
          expectedRevision: read.revision,
          ...change,
        });
        const refusal = readSkillActionRefusal(result);
        if (refusal) return { ok: false, code: refusal };
        const { revision } = SKILL_ACTION_OUTPUT_SCHEMAS_V1[
          'skills.update'
        ].parse(result.ok ? result.result : null);
        const updated = applyChange(read, change, revision);
        // Done/blur can be followed by another action before React commits.
        // The acknowledged revision belongs to this author immediately.
        if (readRef.current?.skillId === skillId) readRef.current = updated;
        setState((prev) =>
          prev.skillId === skillId && prev.read
            ? { ...prev, read: updated }
            : prev,
        );
        return { ok: true, revision };
      } catch {
        return { ok: false, code: 'save_failed' };
      }
    },
    [execute, skillId],
  );

  /** The other side of a conflict: the library's current content, without replacing the page's edit. */
  const readLatest = React.useCallback(
    async (file?: string): Promise<SkillReadResultV1 | null> => {
      if (!skillId) return null;
      const result = await execute('skills.read', {
        skillId,
        ...(file ? { file } : {}),
      });
      const refusal = readSkillActionRefusal(result);
      if (refusal) {
        if (!file) return null;
        requireActionSuccess(result);
        throw new HappyError(refusal, false, { code: refusal });
      }
      return SkillReadResultV1Schema.parse(result.ok ? result.result : null);
    },
    [execute, skillId],
  );

  /** Adopt a read the page asked for (Take theirs, Keep mine's base). */
  const adopt = React.useCallback((read: SkillReadResultV1) => {
    // Keep mine can save immediately, before React commits the adopted revision.
    readRef.current = read;
    setState({ skillId: read.skillId, read, status: 'ready', errorCode: null });
  }, []);

  /** The Action owns confirmation; `'cancelled'` when the person declines its policy prompt. */
  const remove = React.useCallback(async (): Promise<true | 'cancelled'> => {
    const read = readRef.current;
    if (!skillId || !read) throw new HappyError('not_ready', false, { code: 'not_ready' });
    const result = await execute(
      'skills.delete',
      { skillId, expectedRevision: read.revision },
    );
    if (!result.ok && isActionApprovalDeclinedErrorCode(result.errorCode)) return 'cancelled';
    requireActionSuccess(result);
    SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.delete'].parse(
      result.result,
    );
    return true;
  }, [execute, skillId]);

  const duplicate = React.useCallback(async () => {
    if (!skillId) return null;
    const result = await execute('skills.duplicate', { skillId });
    return acknowledgeSkillActionResult('skills.duplicate', result);
  }, [execute, skillId]);

  /** "Export as .zip": the Agent Skills archive the one `skills.export` Action builds, handed to the person. */
  const exportZip = React.useCallback(async (): Promise<boolean> => {
    if (!skillId) return false;
    const result = await execute('skills.export', { skillIds: [skillId] });
    if (readSkillActionRefusal(result)) return false;
    const archive = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.export'].parse(
      result.ok ? result.result : null,
    );
    await saveFileBytes({
      bytes: decodeBase64(archive.bytes),
      fileName: archive.fileName,
      mimeType: 'application/zip',
    });
    return true;
  }, [execute, skillId]);

  /** "Move to folder": the personal folder tree's one placement Action (IR-83), then a fresh list. */
  const moveToFolder = React.useCallback(
    async (folderId: string | null): Promise<boolean> => {
      if (!skillId || folders.status !== 'ready' || folders.stale) return false;
      const result = await execute('artifact.folder.set', {
        artifactId: skillId,
        folderId,
        expectedRevision: folders.revision,
      });
      if (readSkillActionRefusal(result)) return false;
      const receipt = result.ok ? result.result : null;
      const updated =
        receipt && typeof receipt === 'object' && 'status' in receipt
          ? receipt.status === 'updated'
          : true;
      library.retry();
      return updated;
    },
    [execute, folders.revision, folders.stale, folders.status, library, skillId],
  );

  return {
    library,
    listItem,
    read: current.read,
    status: current.status,
    errorCode: current.errorCode,
    folders,
    retry,
    setHold,
    update,
    readLatest,
    adopt,
    remove,
    duplicate,
    exportZip,
    moveToFolder,
    checkNow,
    checkedAt: check.checkedAt,
    checking: check.checking,
    checkFailed: check.failed,
    checkFailureReason: [...new Set(check.results.flatMap(result => result.upstream.state === 'unchecked'
      ? [describeRegistrySourceStatus(result.upstream.reason)] : []))].join(' · '),
    check,
    execute,
    ready,
  } as const;
}

export type SkillDetailModel = ReturnType<typeof useSkillDetail>;

function applyChange(read: SkillReadResultV1, change: SkillChange, revision: string): SkillReadResultV1 {
    let files = read.files;
    let skillMd = read.skillMd;
    for (const fileChange of change.files ?? []) {
        if (fileChange.kind === 'remove') {
            files = files.filter((file) => file.path !== fileChange.path);
            continue;
        }
        const file = fileChange.file;
        const bytes = decodeBase64(file.contentBase64).byteLength;
        files = [...files.filter((entry) => entry.path !== file.path),
            { path: file.path, bytes, ...(file.unixMode != null ? { unixMode: file.unixMode } : {}) }];
        if (file.path === 'SKILL.md') skillMd = readSkillText(file.contentBase64);
    }
    return { ...read, revision, files, skillMd };
}
