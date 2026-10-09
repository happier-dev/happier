import * as React from 'react';
import type { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { useArtifacts } from '@/sync/domains/state/storage';
import { t } from '@/text';

const KIND_BY_HEADER: Readonly<Record<string, PromptArtifactRefV1['kind']>> = {
    'prompt_doc.v2': 'doc',
    'memory_doc.v1': 'doc',
    'prompt_bundle.v2': 'bundle',
};

/**
 * "Add document" for a Context layer that attaches through an Action (a Project, a Session): the
 * active Account's prompts, skills and memory documents in the shared searchable menu. The library
 * list mounts only while the menu is open; choosing hands back the qualified reference and the host
 * runs its layer's attach Action.
 */
export function PromptStackDocumentMenu(props: Readonly<{
    testID: string;
    anchorRef: React.RefObject<View | null>;
    serverId: string;
    /** Documents already in this layer are left out. */
    attachedArtifactIds: ReadonlySet<string>;
    onClose: () => void;
    onPick: (ref: PromptArtifactRefV1, title: string) => void;
}>) {
    const { theme } = useUnistyles();
    const artifacts = useArtifacts();
    const { attachedArtifactIds, onPick, serverId } = props;
    const choices = React.useMemo(() => artifacts.flatMap((artifact) => {
        const kind = KIND_BY_HEADER[String(artifact.header?.kind ?? '')];
        if (!kind || attachedArtifactIds.has(artifact.id)) return [];
        const title = typeof artifact.header?.title === 'string' ? artifact.header.title : (artifact.title ?? t('promptLibrary.untitledPrompt'));
        return [{ id: artifact.id, kind, title, memory: artifact.header?.kind === 'memory_doc.v1' }];
    }), [artifacts, attachedArtifactIds]);
    const items = React.useMemo((): DropdownMenuItem[] => choices.map((choice) => ({
        id: choice.id,
        title: choice.title,
        icon: <Icon name={choice.kind === 'bundle' ? 'sparkle' : choice.memory ? 'bookmark' : 'file-text'} size={18} color={theme.colors.text.secondary} />,
    })), [choices, theme.colors.text.secondary]);
    return (
        <DropdownMenu
            testID={props.testID}
            open
            onOpenChange={(next) => { if (!next) props.onClose(); }}
            items={items}
            selectedId={null}
            search
            searchPlaceholder={t('contextPages.addDocument')}
            emptyLabel={t('contextPages.addDocumentEmpty')}
            popoverAnchorRef={props.anchorRef}
            matchTriggerWidth={false}
            onSelect={(id) => {
                const choice = choices.find((candidate) => candidate.id === String(id));
                if (choice) onPick({ kind: choice.kind, artifactId: choice.id, serverId }, choice.title);
            }}
        />
    );
}
