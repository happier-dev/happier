import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type { PromptExternalLinkEntryV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { useAllMachines, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { buildPromptAssetExportHref } from './buildPromptAssetExportHref';
import { describePromptExternalLinkSubtitle, describePromptExternalLinkTitle } from './promptExternalLinkPresentation';

export const PromptExternalLinksGroup = React.memo(function PromptExternalLinksGroup(props: Readonly<{
    artifactId: string | null;
    libraryKind: 'doc' | 'bundle';
    manageItemTestID: string;
    manageItemSubtitle: string;
    linkTestIDPrefix: string;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const machines = useAllMachines();
    const promptExternalLinksV1 = useSetting('promptExternalLinksV1');

    const links = React.useMemo(() => (
        (promptExternalLinksV1?.links ?? []).filter((entry) => entry.artifactId === props.artifactId)
    ), [promptExternalLinksV1?.links, props.artifactId]);

    if (!props.artifactId) return null;

    const openManageScreen = (link?: PromptExternalLinkEntryV1 | null) => {
        router.push(buildPromptAssetExportHref({
            artifactId: props.artifactId!,
            libraryKind: props.libraryKind,
            link,
        }));
    };

    return (
        <ItemGroup title={t('promptLibrary.externalAssets')}>
            <Item
                testID={props.manageItemTestID}
                title={t('promptLibrary.manageExternalAssets')}
                subtitle={props.manageItemSubtitle}
                icon={<Ionicons name="cloud-upload-outline" size={22} color={theme.colors.accent.blue} />}
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
                        title={title}
                        subtitle={subtitle}
                        icon={<Ionicons name="link-outline" size={22} color={theme.colors.text.secondary} />}
                        onPress={() => openManageScreen(link)}
                        rightElement={(
                            <ItemRowActions
                                title={title}
                                compactActionIds={['manage']}
                                actions={[
                                    {
                                        id: 'manage',
                                        title: t('promptLibrary.manageExternalAssets'),
                                        icon: 'cloud-upload-outline',
                                        onPress: () => openManageScreen(link),
                                    },
                                ]}
                            />
                        )}
                    />
                );
            })}
        </ItemGroup>
    );
});
