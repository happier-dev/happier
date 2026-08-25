import { projectPluginSettingsContributionV2 } from '@happier-dev/protocol';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

import {
    mapV2EditableSettingsGroup,
    type PluginProjectionEditableSettingsGroup,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

/**
 * The one Account-scoped Settings declaration projection that needs no daemon.
 *
 * Account Availability admits the current normalized manifest for an enabled
 * release, and that manifest already carries the plugin's declared Settings
 * contributions. Reuse the Protocol normalizer and the existing UI projection
 * mapper here rather than recreating a Settings parser: two callers need this
 * exact answer — the Settings page's Account recovery route, and the mounted
 * plugin surface's own Account Settings client — and a second derivation is how
 * one of them would start admitting a field the other refuses.
 *
 * A daemon-custodied secret field is dropped. Cold Account access has no
 * selected daemon target, and reinterpreting a daemon secret as an Account
 * SavedSecret would move custody by accident.
 */

export const EMPTY_ACCOUNT_DECLARED_SETTINGS_GROUPS: readonly PluginProjectionEditableSettingsGroup[] = Object.freeze([]);

export function projectAccountDeclaredPluginSettingsGroups(params: Readonly<{
    pluginId: string;
    declaration: PluginPortableReleaseManifestV1 | null | undefined;
}>): readonly PluginProjectionEditableSettingsGroup[] {
    const declaration = params.declaration;
    if (!declaration || declaration.id !== params.pluginId) return EMPTY_ACCOUNT_DECLARED_SETTINGS_GROUPS;

    const groups: PluginProjectionEditableSettingsGroup[] = [];
    for (const definition of declaration.contributes.settings ?? []) {
        if (definition.scope !== 'account' || definition.target.kind !== 'plugin') continue;
        try {
            const projected = projectPluginSettingsContributionV2({
                pluginId: params.pluginId,
                definition,
            });
            const group = mapV2EditableSettingsGroup(projected);
            const fields = group.fields.filter((field) => field.secretCustody !== 'daemon');
            if (fields.length > 0) {
                groups.push(Object.freeze({ ...group, fields: Object.freeze(fields) }));
            }
        } catch {
            // The release is syntactically current but semantically unsuitable
            // for editable Settings. Account access fails closed for that
            // declaration rather than guessing at a partial contribution.
        }
    }
    return groups.length > 0 ? Object.freeze(groups) : EMPTY_ACCOUNT_DECLARED_SETTINGS_GROUPS;
}
