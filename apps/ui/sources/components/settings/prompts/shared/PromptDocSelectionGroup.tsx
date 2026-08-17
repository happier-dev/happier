import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type PromptDocOption = Readonly<{
    id: string;
    title: string;
}>;

export const PromptDocSelectionGroup = React.memo(function PromptDocSelectionGroup(props: Readonly<{
    promptDocs: readonly PromptDocOption[];
    selectedArtifactId: string;
    onSelect: (artifactId: string) => void;
    menuOpen: boolean;
    onMenuOpenChange: (open: boolean) => void;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();

    const promptTargetItems = React.useMemo((): DropdownMenuItem[] => (
        props.promptDocs.map((doc) => ({
            id: doc.id,
            title: doc.title,
            icon: <Icon name="file-text" size={20} color={theme.colors.text.secondary} />,
        }))
    ), [props.promptDocs, theme.colors.text.secondary]);

    const selectedPromptTitle = React.useMemo(() => {
        const selectedPrompt = props.promptDocs.find((doc) => doc.id === props.selectedArtifactId) ?? null;
        return selectedPrompt?.title ?? t('promptLibrary.templateTargetPromptPlaceholder');
    }, [props.promptDocs, props.selectedArtifactId]);

    return (
        <ItemGroup title={t('promptLibrary.templateTarget')}>
            <DropdownMenu
                open={props.menuOpen}
                onOpenChange={props.onMenuOpenChange}
                items={promptTargetItems}
                selectedId={props.selectedArtifactId}
                onSelect={(id) => props.onSelect(String(id))}
                itemTrigger={{
                    title: t('promptLibrary.templateTargetPromptLabel'),
                    subtitle: selectedPromptTitle,
                    icon: <Icon name="file-text" size={29} color={theme.colors.accent.blue} />,
                }}
                rowKind="item"
                connectToTrigger
                variant="default"
            />
            <Item
                testID="promptTemplate.target.edit"
                title={t('promptLibrary.editSelectedPrompt')}
                subtitle={props.selectedArtifactId ? selectedPromptTitle : t('promptLibrary.editSelectedPromptDisabled')}
                icon={<Icon name="pencil" size={20} color={theme.colors.text.secondary} />}
                disabled={!props.selectedArtifactId}
                onPress={() => {
                    if (!props.selectedArtifactId) return;
                    router.push(`/(app)/settings/prompts/docs/${props.selectedArtifactId}`);
                }}
            />
            <Item
                testID="promptTemplate.target.new"
                title={t('promptLibrary.addPrompt')}
                subtitle={t('promptLibrary.addPromptSubtitle')}
                icon={<Icon name="plus-circle" size={20} color={theme.colors.accent.blue} />}
                onPress={() => router.push('/(app)/settings/prompts/docs/new')}
            />
        </ItemGroup>
    );
});
