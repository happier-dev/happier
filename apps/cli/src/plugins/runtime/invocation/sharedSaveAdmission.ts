import { PluginDirectSecretDeclarationV1Schema } from '@happier-dev/protocol/plugins/contributions/settings';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

import type { PluginSharedSaveAdmission } from '../context/secrets';

/**
 * Captures the exact operands disclosed by the existing Action approval owner.
 * The invocation registry publishes this only after that request's fingerprint
 * is approved. Merely proposing the same input never supplies save authority.
 */
export function readReviewedSharedSaveAdmission(
    input: unknown,
    assertCurrent: () => void,
): PluginSharedSaveAdmission | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const operands = input as Readonly<Record<string, unknown>>;
    if (typeof operands.id !== 'string' || typeof operands.purpose !== 'string' || !operands.purpose.trim()) return undefined;
    const declaration = PluginDirectSecretDeclarationV1Schema.safeParse({ id: operands.id });
    if (!declaration.success) return undefined;
    const audience = operands.audience;
    if (audience === null || typeof audience !== 'object' || Array.isArray(audience)
        || Object.keys(audience).some(key => !['accountGrants', 'teamGrants', 'groupGrants'].includes(key))) return undefined;
    const grants = audience as Readonly<Record<string, unknown>>;
    const accountGrants = SharedSavedSecretCreateInputV1Schema.shape.accountGrants.safeParse(grants.accountGrants);
    const teamGrants = SharedSavedSecretCreateInputV1Schema.shape.teamGrants.safeParse(grants.teamGrants);
    const groupGrants = SharedSavedSecretCreateInputV1Schema.shape.groupGrants.safeParse(grants.groupGrants);
    if (!accountGrants.success || !teamGrants.success || !groupGrants.success) return undefined;
    // Schema parsing owns fresh arrays. Freeze them without retaining any
    // mutable reference from the proposal or the approval callback.
    if (accountGrants.data) Object.freeze(accountGrants.data);
    if (teamGrants.data) Object.freeze(teamGrants.data);
    if (groupGrants.data) Object.freeze(groupGrants.data);
    return Object.freeze({
        id: declaration.data.id,
        purpose: operands.purpose,
        audience: Object.freeze({
            ...(accountGrants.data === undefined ? {} : { accountGrants: accountGrants.data }),
            ...(teamGrants.data === undefined ? {} : { teamGrants: teamGrants.data }),
            ...(groupGrants.data === undefined ? {} : { groupGrants: groupGrants.data }),
        }),
        assertCurrent,
    });
}
