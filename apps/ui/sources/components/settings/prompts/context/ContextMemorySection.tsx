import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PromptStackEntryV1 } from '@happier-dev/protocol';

import { MemoryDocumentBody } from '@/components/memory/MemoryDocumentBody';
import { useMemoryDocument } from '@/components/memory/useMemoryDocument';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { CONTEXT_LOAD_CHARS_PER_WORD, CONTEXT_LOAD_WORD_OPTIONS } from '../stacks/promptStackEntryPresentation';

/** Key facts shown before "Show all N" on a Context page (lab `c-ctx`). */
const COLLAPSED_FACTS = 4;
const LOAD_ALL = 'all';

/**
 * A Context page's memory section (lab `c-ctx` A/P; D48): the layer's `memory_doc.v1` document drawn
 * by the shared memory renderer — key facts, then topics — with "+" to remember, the access line,
 * and "How much to load" for the layer that may set the entry's budget. With no memory document the
 * section says what will appear here; the first fact is written from a session (`memory.remember`
 * resolves and creates the target), so no "+" is offered that could not succeed.
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
    /** Takes the memory document out of this layer (the document itself stays in the library). */
    onDetach?: () => void;
    /** Sets or clears the entry's `maxChars`; omitted where this viewer cannot change the layer. */
    onBudgetChange?: (maxChars: number | null) => void;
}>) {
    const { entry, serverId, onBudgetChange } = props;
    const ref = React.useMemo(
        () => (entry && entry.ref.kind === 'doc'
            ? { kind: 'doc' as const, artifactId: entry.ref.artifactId, serverId: entry.ref.serverId ?? serverId }
            : null),
        [entry, serverId],
    );
    const source = useMemoryDocument({ ref, serverId });
    const [composing, setComposing] = React.useState(false);
    const navigateToSession = useNavigateToSession();
    const openSession = React.useCallback((session: Readonly<{ serverId: string; sessionId: string }>) => {
        fireAndForget(navigateToSession(session.sessionId, { serverId: session.serverId }), { tag: 'ContextMemorySection.openSession' });
    }, [navigateToSession]);
    const [budgetOpen, setBudgetOpen] = React.useState(false);
    const maxChars = entry?.maxChars;
    const budgetItems = React.useMemo((): DropdownMenuItem[] => {
        const words: number[] = [...CONTEXT_LOAD_WORD_OPTIONS];
        const stored = maxChars === undefined ? null : Math.max(1, Math.round(maxChars / CONTEXT_LOAD_CHARS_PER_WORD));
        // A budget set elsewhere (an Action, another client) is named as it is, never snapped to an option.
        if (stored !== null && !words.includes(stored)) words.push(stored);
        return [
            { id: LOAD_ALL, title: t('contextPages.load.everything') },
            ...words.sort((a, b) => a - b).map((count) => ({ id: String(count), title: t('contextPages.load.words', { count: count.toLocaleString() }) })),
        ];
    }, [maxChars]);
    const selectedBudget = maxChars === undefined ? LOAD_ALL : String(Math.max(1, Math.round(maxChars / CONTEXT_LOAD_CHARS_PER_WORD)));
    return (
        <ItemGroup
            title={props.title}
            description={props.description}
            action={(source.target && !props.readOnly) || props.onDetach ? (
                <View style={styles.actions}>
                    {source.target && !props.readOnly ? (
                        <IconButton
                            testID={`${props.testID}.remember`}
                            iconName="plus"
                            variant="plain"
                            accessibilityLabel={t('memoryContext.memory.remember')}
                            tooltip={t('memoryContext.memory.remember')}
                            onPress={() => setComposing(true)}
                        />
                    ) : null}
                    {props.onDetach ? (
                        <IconButton
                            testID={`${props.testID}.detach`}
                            iconName="link-break"
                            variant="plain"
                            accessibilityLabel={t('contextPages.detachMemory')}
                            tooltip={t('contextPages.detachMemory')}
                            onPress={props.onDetach}
                        />
                    ) : null}
                </View>
            ) : undefined}
        >
            <MemoryDocumentBody
                testID={props.testID}
                source={source}
                serverId={serverId}
                collapsedFactCount={COLLAPSED_FACTS}
                footer={props.footer}
                readOnly={props.readOnly}
                composing={composing}
                onComposingChange={setComposing}
                emptyText={props.emptyText}
                onOpenSession={openSession}
            />
            {entry && onBudgetChange ? (
                <DropdownMenu
                    testID={`${props.testID}.load`}
                    open={budgetOpen}
                    onOpenChange={setBudgetOpen}
                    items={budgetItems}
                    selectedId={selectedBudget}
                    onSelect={(id) => onBudgetChange(id === LOAD_ALL ? null : Number(id) * CONTEXT_LOAD_CHARS_PER_WORD)}
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
