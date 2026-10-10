import * as React from 'react';
import type { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { useActiveServerAccountScope, useArtifacts } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { promptStackDocumentChoices } from './promptStackDocumentChoices';
import { t } from '@/text';
const EMPTY_ATTACHED_REFS: readonly PromptArtifactRefV1[] = Object.freeze([]);

/**
 * "Add document" for every Context layer (Settings, a Project, a Session's Work › Context): the
 * active Account's prompts, skills and memory documents in the one shared searchable menu, anchored
 * to its button on a pointer screen and a bottom sheet on a phone. The library list mounts only while
 * the menu is open; choosing hands back the qualified reference and the host runs its layer's writer.
 */
export function PromptStackDocumentMenu(props: Readonly<{
    testID: string;
    anchorRef: React.RefObject<View | null>;
    serverId: string;
    /** Documents already in this layer (in this Home) are left out. */
    attachedRefs?: readonly PromptArtifactRefV1[];
    /** Instructions is a PromptDoc-only selection, not general Context. */
    purpose?: 'context' | 'instructions';
    searchPlaceholder?: string;
    onClose: () => void;
    onPick: (ref: PromptArtifactRefV1, title: string) => void;
}>) {
    const { theme } = useUnistyles();
    const artifacts = useArtifacts();
    const { attachedRefs = EMPTY_ATTACHED_REFS, onPick, serverId, purpose } = props;
    const scope = useActiveServerAccountScope(serverId);
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [scope?.serverId, scope?.accountId]);
    const choices = React.useMemo(() => !scope || !lifetime?.isCurrent() ? [] : promptStackDocumentChoices({
        artifacts, attachedRefs, purpose, serverId: scope.serverId, untitled: t('promptLibrary.untitledPrompt'),
    }), [artifacts, attachedRefs, purpose, scope, lifetime]);
    const items = React.useMemo((): DropdownMenuItem[] => choices.map((choice) => ({
        id: choice.id,
        title: choice.label,
        icon: <Icon name={choice.kind === 'skill' ? 'sparkle' : choice.kind === 'memory' ? 'bookmark' : 'file-text'} size={18} color={theme.colors.text.secondary} />,
    })), [choices, theme.colors.text.secondary]);
    return (
        <DropdownMenu
            testID={props.testID}
            open
            onOpenChange={(next) => { if (!next) props.onClose(); }}
            items={items}
            selectedId={null}
            search
            searchPlaceholder={props.searchPlaceholder ?? t('contextPages.addDocument')}
            emptyLabel={t('contextPages.addDocumentEmpty')}
            popoverAnchorRef={props.anchorRef}
            popoverPhonePresentation="sheet"
            popoverAccessibilityLabel={props.searchPlaceholder ?? t('contextPages.addDocument')}
            matchTriggerWidth={false}
            onSelect={(id) => {
                const choice = choices.find((candidate) => candidate.id === String(id));
                if (choice && lifetime?.isCurrent()) onPick(choice.value, choice.label);
            }}
        />
    );
}
