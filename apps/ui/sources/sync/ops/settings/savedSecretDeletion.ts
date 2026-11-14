import { formatSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { listAccountSettingsSavedSecretReferences, type AccountSettingsSavedSecretReference } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { SharedSavedSecretDeleteOutputV1Schema, SavedSecretResourceActionErrorV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { ManagedResourceDependencyV1, ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import { withProfileAccount } from '@/sync/api/account/apiProfileCatalog';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { projectConnectedAccountCredentialReferenceSources } from '@/sync/domains/connectedServices/connectedAccountCredentialReferenceSources';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { applySavedSecretCatalogDeletion, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { isTeamActionApprovalPendingError, runTeamAction, type HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { getSavedSecretCatalogSnapshot } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { captureSavedSecretReferenceStateInContext, operationFailureReason,
    type SavedSecretAdmittedMutationExecute, type SavedSecretResourceOperationResult } from './savedSecretResourceOperations';
import { captureManagedMachinePresetSavedSecretReferencesInContext } from '@/sync/ops/machines/machinePresetCollectionClientImpl';

/** Deletion names current references rather than leaving their bindings dangling. */
export type SavedSecretResourceDeleteResult =
    | SavedSecretResourceOperationResult
    | Readonly<{ ok: false; reason: 'managed_resources_review_required'; resources: readonly ManagedResourceDependencyV1[] }>
    | Readonly<{ ok: false; reason: 'in_use'; references: readonly AccountSettingsSavedSecretReference[] }>;

type SavedSecretResourceDeleteFailure = Exclude<SavedSecretResourceDeleteResult, Readonly<{ ok: true }>>;
type SavedSecretDeleteOutput = Readonly<{ resourceId: string }>;

function savedSecretDeleteFailure(failure: HomeDomainFailure<string>): SavedSecretResourceDeleteFailure {
    if (failure.code === 'managed_resources_review_required') {
        const review = SavedSecretResourceActionErrorV1Schema.safeParse(failure.details);
        if (review.success && review.data.error === 'managed_resources_review_required') {
            return { ok: false, reason: 'managed_resources_review_required', resources: review.data.resources };
        }
    }
    return { ok: false, reason: operationFailureReason(failure.kind) };
}

function readConnectedAccountCredentialRecordsForScope(scope: ServerAccountScope) {
    const { profile } = getStorage().getState();
    if (profile.id !== scope.accountId) return [];
    return projectConnectedAccountCredentialReferenceSources(profile.connectedAccountsV4 ?? [], getConnectedMetadataCatalog(scope).labelsByKey);
}

export async function deleteSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    /** Owner's current Account Settings version; the reference census reads at it. */
    expectedSettingsVersion: number;
    confirmedByPresentUser?: true;
    executeAdmittedMutation?: SavedSecretAdmittedMutationExecute;
    managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
    /** The Action policy decides whether to ask this present-user question. */
    confirmDeletion?: () => Promise<boolean>;
    onApprovalSucceeded?: (value: SavedSecretDeleteOutput) => void | Promise<void>;
    /** The same owner-decoded result for immediate and Inbox-executed refusals. */
    onApprovalFailed?: (code: string, result: SavedSecretResourceDeleteFailure) => void;
}>): Promise<SavedSecretResourceDeleteResult> {
    const resourceRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: params.resourceId });
    try {
        return await withProfileAccount<SavedSecretResourceDeleteResult>(params.scope, undefined, async (context, accountMode) => {
            const confirmDeletion = params.confirmDeletion;
            let confirmation: Promise<boolean> | undefined;
            const presentUserActionConfirmation = confirmDeletion ? () => confirmation ??= confirmDeletion() : undefined;
            const attempt = async (expectedRevision: number, expectedSettingsVersion?: number): Promise<SavedSecretResourceDeleteResult> => {
                const captured = await captureSavedSecretReferenceStateInContext(context, accountMode, { expectedSettingsVersion });
                if (!captured.ok) return captured;
                const { baseline, catalogs: capturedCatalogs, referenceCensus } = captured;
                // A Connected Account whose key is this record keeps it in use; the profile names it (ids only).
                const catalogs = { ...capturedCatalogs, connectedAccountCredentials: readConnectedAccountCredentialRecordsForScope(params.scope) };
                const references = listAccountSettingsSavedSecretReferences(baseline.source.raw, resourceRef, catalogs);
                if (references.length > 0) return { ok: false, reason: 'in_use', references };
                context.assertCurrent();
                const opaquePresetReferences = context.serverIdentityId
                    ? await captureManagedMachinePresetSavedSecretReferencesInContext({
                        scope: params.scope,
                        homeId: context.serverIdentityId,
                        account: context,
                        resourceRef,
                    })
                    : { kind: 'unavailable' as const };
                if (opaquePresetReferences.kind === 'unavailable') return { ok: false, reason: 'unavailable' };
                const outcome = await (params.executeAdmittedMutation ?? runTeamAction)({ scope: params.scope, actionId: 'secrets.shared.delete',
                    input: { resourceId: params.resourceId, expectedRevision,
                        expectedSettingsVersion: baseline.source.version,
                        referenceCensus: { ...referenceCensus, opaquePresetReferences: opaquePresetReferences.opaquePresetReferences },
                        ...(params.managedResourceDispositions ? { managedResourceDispositions: params.managedResourceDispositions } : {}),
                    },
                    parse: value => SharedSavedSecretDeleteOutputV1Schema.parse(value),
                    ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
                    ...(presentUserActionConfirmation ? { executorOptions: { presentUserActionConfirmation } } : {}),
                    onApprovalSucceeded: async receipt => {
                        await applySavedSecretCatalogDeletion(params.scope, receipt.resourceId, expectedRevision,
                            context.accountLifetime.isCurrent());
                        await params.onApprovalSucceeded?.(receipt);
                    },
                    ...(params.onApprovalFailed ? { onApprovalFailed: (code, failure) => params.onApprovalFailed?.(
                        code, savedSecretDeleteFailure(homeDomainFailureFromActionFailure(failure ?? { errorCode: code })),
                    ) } : {}),
                });
                if (outcome.kind === 'succeeded') {
                    await applySavedSecretCatalogDeletion(params.scope, outcome.value.resourceId, expectedRevision,
                        context.accountLifetime.isCurrent());
                    return { ok: true };
                }
                const failure = savedSecretDeleteFailure(outcome.failure);
                if (failure.reason === 'managed_resources_review_required') context.assertCurrent();
                return failure;
            };
            const result = await attempt(params.expectedRevision, params.expectedSettingsVersion);
            // Already-admitted Actions retain their exact input. UI currentness recovery still
            // goes through the same catalog and Action owners, never a direct mutation transport.
            if (result.ok || result.reason !== 'changed' || params.executeAdmittedMutation) return result;
            await refreshSavedSecretCatalog(params.scope, { includeMaterial: false });
            context.assertCurrent();
            const snapshot = getSavedSecretCatalogSnapshot(params.scope);
            const entry = snapshot?.data?.find(candidate => candidate.ref === resourceRef);
            if (!snapshot || snapshot.stale || snapshot.error || entry?.revision == null) {
                return { ok: false, reason: 'unavailable' };
            }
            return attempt(entry.revision);
        });
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    }
}
