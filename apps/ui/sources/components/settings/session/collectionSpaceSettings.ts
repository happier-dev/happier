import { CollectionSpaceSelectionValueV1Schema, getDefaultCollectionSpaceIdV1, reduceCollectionSpacesV1, resolveCollectionSpacesV1, resolveCollectionSpaceSelectionV1,
    type CollectionEntityKindV1, type CollectionSpacesV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { builtInSettingUiDeclaration, SETTING_VALUE_UNAVAILABLE,
    type SettingDeclaration, type SettingOperationContext, type SettingsPageDeclaration, type SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { writeCollectionSpaceSelectionV1 } from '@/sync/domains/session/listing/sessionListSpaces';
import { readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { readCollectionSpaceDefaultV1 } from './collectionSpaceDefaults';

class SpaceMutationRejected extends Error {}

/** The settings Action and mounted controls submit the same intent to the existing scoped CAS writer. */
export async function invokeCollectionSpaceSetting(entityKind: CollectionEntityKindV1, context: SettingOperationContext) {
    const operation = context.input;
    if (!context.accountScope || !context.isCurrent()) return { status: 'unavailable' as const, reason: 'setting_not_bound' };
    if (operation?.kind !== 'collection_space' || operation.entityKind !== entityKind) return { status: 'unavailable' as const, reason: 'space_entity_mismatch' };
    const mutation = operation.mutation;
    const changesSelection = mutation.op === 'create' || mutation.op === 'delete';
    if (changesSelection && (!context.readLocalSettings || !context.writeLocalSettings)) {
        return { status: 'unavailable' as const, reason: 'setting_not_bound' };
    }
    const defaultId = getDefaultCollectionSpaceIdV1(entityKind);
    const needsDefault = mutation.op === 'resetDefault' || (mutation.op === 'edit' || mutation.op === 'associateTag') && mutation.spaceId === defaultId
        || mutation.op === 'reorder' && (mutation.spaceId === defaultId || mutation.beforeSpaceId === defaultId);
    if (needsDefault && !context.readLocalSettings) return { status: 'unavailable' as const, reason: 'setting_not_bound' };
    const defaultSpace = needsDefault && context.readLocalSettings
        ? readCollectionSpaceDefaultV1(entityKind, await context.readSettings(), context.readLocalSettings()) : undefined;
    if (!context.isCurrent()) return { status: 'unavailable' as const, reason: 'setting_not_bound' };
    let accepted: CollectionSpacesV1 | undefined;
    let reason = 'space_not_found';
    try {
        await context.mutateSettings(settings => {
            const reduced = reduceCollectionSpacesV1(settings.collectionSpacesV1, operation, defaultSpace ? { [entityKind]: defaultSpace } : {});
            if (!reduced.ok) { reason = reduced.reason; throw new SpaceMutationRejected(); }
            accepted = reduced.value;
            // The reducer is typed readonly; the catalog's admitted JSON value carries the same shape.
            return { collectionSpacesV1: reduced.value as typeof settings.collectionSpacesV1 };
        }, { rebaseOnConflict: true });
    } catch (error) {
        if (error instanceof SpaceMutationRejected) return { status: 'unavailable' as const, reason };
        throw error;
    }
    if (changesSelection && accepted && context.isCurrent() && context.readLocalSettings && context.writeLocalSettings) {
        const local = context.readLocalSettings();
        const selectedId = local.collectionSpaceV1.byAccountScope[accountSettingsScopeKeySuffix(context.accountScope)]?.[entityKind]?.spaceId;
        const nextId = mutation.op === 'create' ? mutation.space.id
            : mutation.op === 'delete' && selectedId === mutation.spaceId ? defaultId : undefined;
        if (nextId !== undefined) {
            // Definition acceptance is the navigation boundary. Never select before CAS or on another device.
            const catalog = accepted;
            await writeCollectionSpaceSelectionV1({ scope: context.accountScope, entityKind, spaceId: nextId,
                isCurrent: context.isCurrent, readSettings: () => ({ collectionSpacesV1: catalog }),
                readLocalSettings: context.readLocalSettings, writeLocalSettings: context.writeLocalSettings });
        }
    }
    return accepted ? { status: 'completed' as const, value: accepted as CollectionSpacesV1 & import('@/components/settings/catalog/settingDeclarations').SettingValue }
        : { status: 'unavailable' as const, reason: 'setting_not_bound' };
}

function selectedSpaceDeclaration(entityKind: CollectionEntityKindV1): SettingDeclaration {
    return { storage: { scope: 'local', kind: 'localOwner', access: 'read_write', requiresAccountScope: true,
        read: async (local, context) => {
            if (!context?.accountScope) return SETTING_VALUE_UNAVAILABLE;
            const settings = await context.readSettings?.();
            return { spaceId: resolveCollectionSpaceSelectionV1(local.collectionSpaceV1, accountSettingsScopeKeySuffix(context.accountScope),
                entityKind, settings ? resolveCollectionSpacesV1(settings.collectionSpacesV1, entityKind) : [], { authoritative: Boolean(settings) }) };
        },
        parse: value => {
            const parsed = CollectionSpaceSelectionValueV1Schema.safeParse(value);
            return parsed.success ? { success: true, value: parsed.data } : { success: false };
        },
        commit: async (local, value, write, context) => {
            const selection = CollectionSpaceSelectionValueV1Schema.parse(value);
            if (!context?.accountScope || !context.isCurrent() || !context.readSettings) return SETTING_VALUE_UNAVAILABLE;
            const result = await writeCollectionSpaceSelectionV1({ scope: context.accountScope, entityKind, spaceId: selection.spaceId,
                isCurrent: context.isCurrent, readSettings: context.readSettings,
                readLocalSettings: context.readLocalSettings ?? (() => local), writeLocalSettings: write });
            if (!result.ok) return SETTING_VALUE_UNAVAILABLE;
        },
    } };
}
function definitionsDeclaration(entityKind: CollectionEntityKindV1): SettingDeclaration {
    return { operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
        invoke: context => invokeCollectionSpaceSetting(entityKind, context) } };
}

/** Header/settings compositions consume these same refs; no second persistence or Action registry. */
export function collectionSpaceSettingRefs(entityKind: CollectionEntityKindV1): Readonly<{ spaces: SettingRef; selectedSpace: SettingRef }> {
    const prefix = entityKind === 'sessionWork' ? 'session' : entityKind;
    const ref = (suffix: string, declaration: SettingDeclaration): SettingRef => {
        const anchor = `${prefix}.list.${suffix}`;
        const metadata = readBuiltInSettingDeclarationV1(anchor)!;
        return { ...builtInSettingUiDeclaration(anchor), ...declaration, anchor, sectionId: metadata.sectionId };
    };
    return { spaces: ref('spaces', definitionsDeclaration(entityKind)), selectedSpace: ref('selectedSpace', selectedSpaceDeclaration(entityKind)) };
}
export const COLLECTION_SPACE_SETTINGS: readonly SettingsPageDeclaration[] = (['sessionWork', 'workflow', 'discussion'] as const).map(entityKind => {
    const settings = collectionSpaceSettingRefs(entityKind);
    const sectionId = settings.spaces.sectionId;
    // Manage spaces is the rows' home: search and the title menu open that entity's page at the same anchors.
    const subpage = { id: 'spaces', route: collectionSpacesManageHref(entityKind), anchors: 'page' as const,
        titleKey: entityKind === 'sessionWork' ? 'sessionsList.spacesManageSessions' as const
            : entityKind === 'workflow' ? 'sessionsList.spacesManageWorkflows' as const : 'sessionsList.spacesManageDiscussions' as const };
    return { pageId: entityKind === 'sessionWork' ? 'session' : 'settings', subpage, sections: {
        list: { titleKey: 'sessionsList.spacesTitle', settings },
    }, sectionRefs: { list: { id: sectionId, settingAnchors: [settings.spaces.anchor, settings.selectedSpace.anchor] } }, settings };
});

/** Manage spaces for one entity (Settings → Sessions → Spaces); every list's title menu opens it. */
export function collectionSpacesManageHref(entityKind: CollectionEntityKindV1): `/settings/session/spaces?entity=${CollectionEntityKindV1}` {
    return `/settings/session/spaces?entity=${entityKind}`;
}
