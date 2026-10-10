import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { PromptExternalLinkEntryV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useAllMachines } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { t } from '@/text';

import { buildPromptAssetExportHref } from './buildPromptAssetExportHref';
import { describePromptExternalLinkSubtitle, describePromptExternalLinkTitle } from './promptExternalLinkPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';

export const PromptExternalLinksGroup = React.memo(function PromptExternalLinksGroup(props: Readonly<{
    artifactId: string | null;
    libraryKind: 'doc' | 'bundle';
    manageItemTestID: string;
    manageItemSubtitle: string;
    linkTestIDPrefix: string;
    scope?: ServerAccountScope | null;
}>) {
    const router = useRouter();
    const activeMachines = useAllMachines();
    const activeScope = useAccountSettingsScope();
    const machines = props.scope === undefined || areAccountSettingsScopesEqual(props.scope, activeScope) ? activeMachines : [];
    const promptExternalLinksV1 = usePromptLibraryCatalogValue('external-links', props.scope).value;

    const links = React.useMemo(() => (
        (promptExternalLinksV1?.links ?? []).filter((entry) => entry.artifactId === props.artifactId)
    ), [promptExternalLinksV1?.links, props.artifactId]);

    if (!props.artifactId) return null;

    const openManageScreen = (link?: PromptExternalLinkEntryV1 | null) => {
        router.push(buildPromptAssetExportHref({
            artifactId: props.artifactId!,
            libraryKind: props.libraryKind,
            serverId: props.scope?.serverId,
            link,
        }));
    };

    return (
        <ItemGroup title={t('promptLibrary.externalAssets')} description={t('promptLibrary.surface.externalLinksDescription')}>
            <Item
                testID={props.manageItemTestID}
                icon={<Icon name="cloud-arrow-up" />}
                title={t('promptLibrary.manageExternalAssets')}
                subtitle={props.manageItemSubtitle}
                onPress={() => openManageScreen()}
            />

            {links.map((link, index) => {
                const title = describePromptExternalLinkTitle(link);
                const subtitle = describePromptExternalLinkSubtitle({
                    link,
                    machines,
                    scopeLabel: link.scope === 'project'
                        ? t('promptLibrary.externalAssetsProjectScope')
                        : t('promptLibrary.externalAssetsUserScope'),
                });
                return (
                    <Item
                        key={link.id}
                        testID={`${props.linkTestIDPrefix}.${index}`}
                        icon={<Icon name="link" />}
                        title={title}
                        subtitle={subtitle}
                        onPress={() => openManageScreen(link)}
                    />
                );
            })}
        </ItemGroup>
    );
});
