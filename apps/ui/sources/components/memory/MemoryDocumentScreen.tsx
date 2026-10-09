import { MEMORY_ARCHIVE_TOPIC_TITLE_V1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import * as React from 'react';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useActiveServerAccountScope, useArtifact } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { MemoryDocumentBody, memoryTopicLabel } from './MemoryDocumentBody';
import { useMemoryDocument } from './useMemoryDocument';

/**
 * A memory document's own pages (D48): without `topic`, the index — every key fact, then the topic
 * list; with `topic`, that one topic's facts (the archive is a topic). "Show all", a topic row and a
 * memory search hit all open here. It is the shared memory renderer with nothing collapsed.
 */
export const MemoryDocumentScreen = React.memo(function MemoryDocumentScreen(props: Readonly<{
    artifactId: string;
    serverId?: string;
    topic?: string;
}>) {
    const scope = useActiveServerAccountScope();
    const serverId = props.serverId?.trim() || scope?.serverId || null;
    const ref = React.useMemo(
        () => (serverId ? { kind: 'doc' as const, artifactId: props.artifactId, serverId } : null),
        [props.artifactId, serverId],
    );
    const source = useMemoryDocument({ ref, serverId, ...(props.topic ? { topic: props.topic } : {}) });
    const row = useArtifact(props.artifactId);
    const navigateToSession = useNavigateToSession();
    const openSession = React.useCallback((target: Readonly<{ serverId: string; sessionId: string }>) => {
        fireAndForget(navigateToSession(target.sessionId, { serverId: target.serverId }), { tag: 'MemoryDocumentScreen.source' });
    }, [navigateToSession]);
    const [composing, setComposing] = React.useState(false);
    const view = source.view;
    // Someone else's memory shared for reading stays read-only; unknown access is treated as the owner's.
    const readOnly = row?.access === 'view';
    const title = props.topic ? memoryTopicLabel(props.topic) : (view?.title ?? t('memoryContext.memory.title'));
    const description = props.topic
        ? (view?.topic?.summary ?? '')
        : t('memoryContext.memory.pageDescription');
    return (
        <ItemList>
            <SettingsPageHeader title={title} description={description} />
            <ItemGroup
                title={props.topic ? t('memoryContext.memory.factsTitle') : t('memoryContext.memory.keyFactsTitle')}
                description={props.topic ? undefined : t('memoryContext.memory.keyFactsDescription')}
                action={source.target && !readOnly && props.topic !== MEMORY_ARCHIVE_TOPIC_TITLE_V1 ? (
                    <IconButton
                        testID="memory-document.remember"
                        iconName="plus"
                        variant="plain"
                        accessibilityLabel={t('memoryContext.memory.remember')}
                        tooltip={t('memoryContext.memory.remember')}
                        onPress={() => setComposing(true)}
                    />
                ) : undefined}
            >
                <MemoryDocumentBody
                    testID="memory-document"
                    source={source}
                    serverId={serverId ?? ''}
                    readOnly={readOnly}
                    composing={composing}
                    onComposingChange={setComposing}
                    emptyText={t('memoryContext.memory.empty')}
                    onOpenSession={openSession}
                />
            </ItemGroup>
        </ItemList>
    );
});
