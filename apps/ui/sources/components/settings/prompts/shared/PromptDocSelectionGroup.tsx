import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

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
            icon: <Ionicons name="document-text-outline" size={22} color={theme.colors.textSecondary} />,
        }))
    ), [props.promptDocs, theme.colors.textSecondary]);

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
                    icon: <Ionicons name="document-text-outline" size={29} color={theme.colors.accent.blue} />,
                }}
                rowKind="item"
                connectToTrigger
                variant="default"
            />
            <Item
                testID="promptTemplate.target.edit"
                title={t('promptLibrary.editSelectedPrompt')}
                subtitle={props.selectedArtifactId ? selectedPromptTitle : t('promptLibrary.editSelectedPromptDisabled')}
                icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.textSecondary} />}
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
                icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
                onPress={() => router.push('/(app)/settings/prompts/docs/new')}
            />
        </ItemGroup>
    );
});
