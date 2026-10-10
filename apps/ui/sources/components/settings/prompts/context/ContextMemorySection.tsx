import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PromptStackEntryV1 } from '@happier-dev/protocol';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';

import { MemoryDocumentBody } from '@/components/memory/MemoryDocumentBody';
import { MemorySearchPanel } from '@/components/memory/MemorySearchPanel';
import { useMemoryDocument } from '@/components/memory/useMemoryDocument';
import { useMemoryCreationReceipt } from '@/components/memory/useMemoryCreationReceipt';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { promptStackBudgetChoices } from '../stacks/promptStackBudgetChoices';

/** Key facts shown before "Show all N" on a Context page (lab `c-ctx`). */
const COLLAPSED_FACTS = 4;

/**
 * A Context page's memory section (lab `c-ctx` A/P; D48): the layer's `memory_doc.v1` document drawn
 * by the shared memory renderer — key facts, then topics — with "+" to remember, the access line,
 * and "How much to load" for the layer that may set the entry's budget. With no memory document the
 * section offers the same lazy `memory.remember` Action for its Account or Project scope.
 */
export const ContextMemorySection = React.memo(function ContextMemorySection(props: Readonly<{
    testID: string;
    title: string;
    description: string;
    serverId: string;
    entry: PromptStackEntryV1 | null;
    footer: string;
    emptyText: string;
    readOnly?: boolean;
    scopeTarget?: MemoryScopeTargetV1;
    /** Takes the memory document out of this layer (the document itself stays in the library). */
    onDetach?: () => void;
    /** Sets or clears the entry's `maxChars`; omitted where this viewer cannot change the layer. */
    onBudgetChange?: (maxChars: number | null) => void;
    /** Context use is separate from permission to edit the memory document. */
    onEnabledChange?: (enabled: boolean) => void;
    disabled?: boolean;
}>) {
    const { entry, serverId, onBudgetChange } = props;
    const attachedRef = React.useMemo(
        () => (entry && entry.ref.kind === 'doc'
            ? { kind: 'doc' as const, artifactId: entry.ref.artifactId, serverId: entry.ref.serverId ?? serverId }
            : null),
        [entry, serverId],
    );
    const { receipt, ref, onCreatedMemory } = useMemoryCreationReceipt({
        serverId, scopeKey: JSON.stringify(props.scopeTarget), attachedRef,
    });
    const unattached = receipt?.attachment === 'conflict';
    const source = useMemoryDocument({ ref, serverId });
    const canRemember = !props.readOnly && Boolean(source.target || (!entry && source.status === 'none' && props.scopeTarget));
    const [composing, setComposing] = React.useState(false);
    // Search takes the section's body while it is open (the same panel Work › Memory opens).
    const [searching, setSearching] = React.useState(false);
    const navigateToSession = useNavigateToSession();
    const openSession = React.useCallback((session: Readonly<{ serverId: string; sessionId: string }>) => {
        fireAndForget(navigateToSession(session.sessionId, { serverId: session.serverId }), { tag: 'ContextMemorySection.openSession' });
    }, [navigateToSession]);
    const [budgetOpen, setBudgetOpen] = React.useState(false);
    const maxChars = entry?.maxChars;
    const budgetItems = React.useMemo(() => promptStackBudgetChoices(maxChars, {
        everything: t('contextPages.load.everything'), words: count => t('contextPages.load.words', { count: count.toLocaleString() }),
    }), [maxChars]);
    const selectedBudget = budgetItems.find(choice => choice.maxChars === (maxChars ?? null))?.id ?? 'all';
    return (
        <ItemGroup
            title={props.title}
            description={props.description}
            action={(
                <View style={styles.actions}>
                    <IconButton
                        testID={`${props.testID}.search`}
                        iconName={searching ? 'x' : 'magnifying-glass'}
                        variant="plain"
                        accessibilityLabel={searching ? t('memoryContext.memory.closeSearch') : t('memoryContext.memory.search')}
                        tooltip={searching ? t('memoryContext.memory.closeSearch') : t('memoryContext.memory.search')}
                        expanded={searching}
                        onPress={() => { setSearching((open) => !open); setComposing(false); }}
                    />
                    {canRemember && !searching ? (
                        <IconButton
                            testID={`${props.testID}.remember`}
                            iconName="plus"
                            variant="plain"
                            accessibilityLabel={t('memoryContext.memory.remember')}
                            tooltip={t('memoryContext.memory.remember')}
                            onPress={() => setComposing(true)}
                        />
                    ) : null}
                    {!unattached && props.onDetach ? (
                        <IconButton
                            testID={`${props.testID}.detach`}
                            iconName="link-break"
                            variant="plain"
                            accessibilityLabel={t('contextPages.detachMemory')}
                            tooltip={t('contextPages.detachMemory')}
                            onPress={props.onDetach}
                        />
                    ) : null}
                    {!unattached && entry && props.onEnabledChange ? <Switch
                        testID={`${props.testID}.enabled`}
                        value={entry.enabled}
                        disabled={props.disabled}
                        accessibilityLabel={props.title}
                        onValueChange={props.onEnabledChange}
                    /> : null}
                </View>
            )}
        >
            {searching ? <MemorySearchPanel testID={`${props.testID}.searchPanel`} serverId={serverId} /> : null}
            {searching ? null : <MemoryDocumentBody
                testID={props.testID}
                source={source}
                serverId={serverId}
                collapsedFactCount={COLLAPSED_FACTS}
                footer={props.footer}
                readOnly={props.readOnly}
                composing={composing}
                onComposingChange={setComposing}
                scopeTarget={props.scopeTarget}
                onCreatedMemory={onCreatedMemory}
                emptyText={props.emptyText}
                onOpenSession={openSession}
            />}
            {!searching && !unattached && entry && onBudgetChange ? (
                <DropdownMenu
                    testID={`${props.testID}.load`}
                    open={budgetOpen}
                    onOpenChange={setBudgetOpen}
                    items={budgetItems}
                    selectedId={selectedBudget}
                    onSelect={(id) => { const choice = budgetItems.find(candidate => candidate.id === id); if (choice) onBudgetChange(choice.maxChars); }}
                    itemTrigger={{
                        title: t('contextPages.load.title'),
                        subtitle: t('contextPages.load.description'),
                        itemProps: { accessoryLayout: 'adaptive' },
                    }}
                />
            ) : null}
        </ItemGroup>
    );
});

const styles = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
}));
