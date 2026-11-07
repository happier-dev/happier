import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { admitProfileAccount, withProfileAccount } from '@/sync/api/account/apiProfileCatalog';
import { readSavedSecretMaterialInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { createSavedSecretResource, type SavedSecretAdmittedMutationExecute, type SavedSecretResourceOperationResult } from './savedSecretResourceOperations';

export type SavedSecretTeamCopy = Readonly<{
    sourceRef: string;
    sourceRevision: number;
    ref: string;
    resourceRevision: number;
}>;

export type SavedSecretTeamCopyResult =
    | Readonly<{ ok: true; copies: readonly SavedSecretTeamCopy[] }>
    | Readonly<{ ok: false; reason: Extract<SavedSecretResourceOperationResult, { ok: false }>['reason']; copies: readonly SavedSecretTeamCopy[] }>;

/** Client-custodied step of the reviewed Move to Team Action; this never dispatches its own review. */
export async function copyUsedSavedSecretResourcesToTeam(params: Readonly<{
    scope: ServerAccountScope;
    teamId: string;
    references: readonly Readonly<{ ref: string; resourceRevision: number }>[];
    executeAdmittedMutation: SavedSecretAdmittedMutationExecute;
    signal?: AbortSignal;
}>): Promise<SavedSecretTeamCopyResult> {
    const copies: SavedSecretTeamCopy[] = [];
    try {
        const references = new Map<string, typeof params.references[number]>();
        for (const reference of params.references) {
            if (parseSavedSecretRefV1(reference.ref).kind !== 'shared_resource'
                || !Number.isSafeInteger(reference.resourceRevision) || reference.resourceRevision < 1) {
                return { ok: false, reason: 'unavailable', copies };
            }
            references.set(JSON.stringify([reference.ref, reference.resourceRevision]), reference);
        }
        params.signal?.throwIfAborted();
        if (!references.size) return { ok: true, copies };
        return await withProfileAccount<SavedSecretTeamCopyResult>(params.scope, params.signal, async (context, mode) => {
            for (const reference of references.values()) {
                const source = await readSavedSecretMaterialInContext(context, reference.ref,
                    { expectedRevision: reference.resourceRevision, signal: params.signal });
                if (!source.ok) return { ...source, copies };
                const created = await admitProfileAccount(context, async (_context, currentMode) => {
                    if (currentMode !== mode) return { ok: false as const, reason: 'changed' as const };
                    return await createSavedSecretResource({ scope: params.scope, name: source.name, kind: source.kind,
                        value: source.value, accountGrants: [], teamGrants: [params.teamId], groupGrants: [],
                        executeAdmittedMutation: params.executeAdmittedMutation, signal: params.signal });
                });
                if (!created.ok) return { ...created, copies };
                copies.push({ sourceRef: reference.ref, sourceRevision: reference.resourceRevision,
                    ref: created.resourceRef, resourceRevision: created.revision });
                if (created.preparation?.status === 'pending') return { ok: false, reason: 'unavailable', copies };
                params.signal?.throwIfAborted();
                context.assertCurrent();
            }
            return { ok: true, copies };
        });
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'unavailable', copies };
    }
}
