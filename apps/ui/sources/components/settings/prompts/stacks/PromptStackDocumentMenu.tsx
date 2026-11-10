import * as React from 'react';
import type { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { useActiveServerAccountScope, useArtifacts, useArtifactsLoaded } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { promptStackDocumentChoices } from './promptStackDocumentChoices';
import { t } from '@/text';
const EMPTY_ATTACHED_REFS: readonly PromptArtifactRefV1[] = Object.freeze([]);
const INSTRUCTION_KINDS: readonly string[] = Object.freeze(['prompt_doc.v2']);
const CONTEXT_KINDS: readonly string[] = Object.freeze(['memory_doc.v1', 'prompt_doc.v2']);
const NO_KINDS: readonly string[] = Object.freeze([]);

/**
 * "Add document" for every Context layer (Settings, a Project, a Session's Work › Context): the
 * active Account's prompts and memory documents in the one shared searchable menu, anchored
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
    const artifacts = useArtifacts('promptLibrary');
    const { attachedRefs = EMPTY_ATTACHED_REFS, onPick, serverId, purpose } = props;
    const scope = useActiveServerAccountScope(serverId);
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [scope?.serverId, scope?.accountId]);
    const admitted = Boolean(scope && lifetime?.isCurrent());
    const kinds = purpose === 'instructions' ? INSTRUCTION_KINDS : CONTEXT_KINDS;
    const loaded = useArtifactsLoaded(kinds);
    // The picker is the demand boundary. Reuse Sync's selected inventory, including recovery and
    // cancellation; a snapshot with no rows is not evidence that the requested library is empty.
    const inventory = useArtifactInventoryRead(admitted && !loaded, admitted ? kinds : NO_KINDS);
    const unavailable = !admitted || inventory.failed;
    const choices = React.useMemo(() => !scope || !lifetime?.isCurrent() ? [] : promptStackDocumentChoices({
        artifacts, attachedRefs, purpose, serverId: scope.serverId, untitled: t('promptLibrary.untitledPrompt'),
    }), [artifacts, attachedRefs, purpose, scope, lifetime]);
    const items = React.useMemo((): DropdownMenuItem[] => choices.map((choice) => ({
        id: choice.id,
        title: choice.label,
        icon: <Icon name={choice.kind === 'memory' ? 'bookmark' : 'file-text'} size={18} color={theme.colors.text.secondary} />,
    })), [choices, theme.colors.text.secondary]);
    return (
        <DropdownMenu
            testID={props.testID}
            open
            onOpenChange={(next) => { if (!next) props.onClose(); }}
            items={items}
            selectedId={null}
            header={unavailable || !loaded ? <SurfaceStateCard
                testID={`${props.testID}.readState`}
                size="line"
                lineDensity="menu"
                kind={unavailable ? 'unavailable' : 'loading'}
                title={t(unavailable ? 'common.error' : 'common.loading')}
                action={unavailable && admitted ? { label: t('common.retry'), onPress: inventory.retry } : undefined}
            /> : undefined}
            search
            searchPlaceholder={props.searchPlaceholder ?? t('contextPages.addDocument')}
            emptyLabel={admitted && loaded && !unavailable ? t('contextPages.addDocumentEmpty') : null}
            popoverAnchorRef={props.anchorRef}
            popoverAccessibilityLabel={props.searchPlaceholder ?? t('contextPages.addDocument')}
            matchTriggerWidth={false}
            onSelect={(id) => {
                const choice = choices.find((candidate) => candidate.id === String(id));
                if (choice && lifetime?.isCurrent()) onPick(choice.value, choice.label);
            }}
        />
    );
}
