import { z } from 'zod/mini';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { SpawnSessionErrorCodeSchema } from '@happier-dev/protocol/spawnSession';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { ensureSessionDirectory } from '@/daemon/startup/ensureSessionDirectory';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { createWorkspaceEffectScmRegistry, type AdmittedScmEffect } from '@/workspaces/activation/workspaceEffect';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { recordDirectoryPreflightRefusal, type DirectoryPreflightRefusal } from '@/session/creation/directoryPreflightDiagnostic';

/** Host-private pipe: the parent supplies its held runtime's admitted projection,
 * never raw plugin discovery or Account credentials. */
export const NativeSessionDirectoryCommandSchema = z.strictObject({
  kind: z.literal('session.directory.prepare'),
  request: SessionCreationTargetPreparationRequestV1Schema,
  approvedNewDirectoryCreation: z.boolean(),
  scm: z.optional(z.custom<AdmittedScmEffect>()),
});
export const NativeSessionDirectoryResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), directory: z.string(), directoryCreated: z.boolean(), checkoutCreated: z.boolean() }),
  z.strictObject({ ok: z.literal(false), result: z.union([
    z.strictObject({ type: z.literal('requestToApproveDirectoryCreation'), directory: z.string() }),
    z.strictObject({ type: z.literal('error'), errorCode: SpawnSessionErrorCodeSchema, errorMessage: z.string() }),
  ]) }),
]);

export type NativeSessionDirectoryResult = z.infer<typeof NativeSessionDirectoryResultSchema>;

/** Runs the existing Session directory/SCM owners in the selected native process. */
export async function executeNativeSessionDirectoryPreparation(
  command: z.infer<typeof NativeSessionDirectoryCommandSchema>, signal?: AbortSignal,
  onDirectoryPreflightRefused?: (diagnostic: DirectoryPreflightRefusal) => void,
): Promise<z.infer<typeof NativeSessionDirectoryResultSchema>> {
  signal?.throwIfAborted();
  if (command.request.directory.kind !== 'path') throw new Error('Native Session directory requires a path');
  const requestedDirectory = command.request.directory.path;
  const refused = (branch: DirectoryPreflightRefusal['branch'], directory?: string) => {
    const diagnostic: DirectoryPreflightRefusal = { branch, directoryKind: 'path',
      requestedDirectory, ...(directory ? { directory } : {}),
      ...(process.geteuid ? { effectiveUid: process.geteuid() } : {}) };
    try { (onDirectoryPreflightRefused ?? recordDirectoryPreflightRefusal)(diagnostic); }
    catch { /* Diagnostics cannot replace the native preparation result. */ }
  };
  let directory: string;
  let checkoutCreated = false;
  if (command.request.checkoutCreationDraft) {
    if (!command.scm) throw new Error('Admitted Session SCM projection is unavailable');
    const scm = await createWorkspaceEffectScmRegistry(command.scm, {});
    try {
      const target = await prepareSessionCreationTarget({ request: command.request, scmRegistry: scm.registry, signal,
        onDirectoryPreflightRefused });
      if (!target.ok) return { ok: false, result: { type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: target.code } };
      directory = target.directory;
      checkoutCreated = true;
    } finally { await scm.dispose(); }
  } else {
    const canonical = resolveCanonicalAbsolutePath(command.request.directory.path);
    if (!canonical) {
      refused('canonical_path');
      return { ok: false, result: { type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: 'invalid_directory' } };
    }
    directory = canonical.path;
  }
  const ensured = await ensureSessionDirectory({ directory,
    approvedNewDirectoryCreation: command.approvedNewDirectoryCreation });
  signal?.throwIfAborted();
  if (!ensured.ok && ensured.response.type === 'error') refused('directory_readiness', directory);
  return ensured.ok ? { ok: true, directory, directoryCreated: ensured.directoryCreated, checkoutCreated }
    : { ok: false, result: ensured.response };
}
