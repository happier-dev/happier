import type { CollectionEntityKindV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';
import { collectionSpaceSettingRefs } from './collectionSpaceSettings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

/** Publish the header's existing editor callback under its Settings declaration and current view lifetime. */
export function useCollectionFilterSettingsCommand(input: Readonly<{
    entityKind: CollectionEntityKindV1;
    enabled: boolean;
    contextKey: string;
    accountScope: AccountSettingsScope | null;
    openFilter(): void;
}>): void {
    const setting = collectionSpaceSettingRefs(input.entityKind).filters;
    useCurrentUiContextLocalCommands(input.enabled && input.accountScope ? [{ key: setting.anchor, title: t(setting.titleKey),
        setting: { anchor: setting.anchor, scope: input.accountScope }, invoke: input.openFilter }] : [], { contextKey: input.contextKey });
}
