import { happierPageTextMetrics, HAPPIER_WORK_PANE_METRICS } from '@happier-dev/plugin-ui/presentation';
import {
    isMemoryDocumentSearchHitV1,
    type MemoryDocumentSearchCoverageV1,
    type MemoryDocumentSearchHitV1,
    type MemorySearchCorpusV1,
    type MemorySearchHitV1,
} from '@happier-dev/protocol/memory/memorySearch';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';
import { useActiveServerAccountScope, useSessionSelector } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { formatMemoryDate, memoryTopicLabel } from './MemoryDocumentBody';
import { memoryDocumentSearchHitHref } from './memoryDocumentRoutes';

const CORPORA: readonly MemorySearchCorpusV1[] = ['documents', 'sessions'];
/** Typing settles before a machine is asked; a superseded query is cancelled, not raced. */
const SEARCH_SETTLE_MS = 250;
const MIN_QUERY_LENGTH = 2;

type Results = Readonly<{
    query: string;
    status: 'searching' | 'ready' | 'failed';
    documentsCoverage: MemoryDocumentSearchCoverageV1 | null;
    documents: readonly MemoryDocumentSearchHitV1[];
    sessions: readonly MemorySearchHitV1[];
}>;

/**
 * One search over remembered facts (every topic, the archive included) and past sessions (lab
 * `c-mem S`). One engine: the daemon's `memory.search` with the document corpus, through the shared
 * provider decision; it never opens a second index. A remembered hit opens the memory page at its
 * topic (D4-3 `{ type: 'topic', title }`); a session hit opens that session at the match.
 */
export const MemorySearchPanel = React.memo(function MemorySearchPanel(props: Readonly<{
    testID: string;
    serverId: string;
}>) {
    const styles = stylesheet;
    const { serverId, testID } = props;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const accountScope = useActiveServerAccountScope();
    const provider = useMemorySearchProvider({ kind: 'exact', serverId }, { corpora: CORPORA });
    const target = provider.queryAvailable ? provider.daemonTarget : null;
    const [query, setQuery] = React.useState('');
    const [results, setResults] = React.useState<Results | null>(null);
    const normalized = query.trim();
    const accountId = accountScope?.accountId ?? null;
    const machineId = target?.machineId ?? null;
    const targetServerId = target?.serverId ?? null;

    React.useEffect(() => {
        if (normalized.length < MIN_QUERY_LENGTH || !machineId || !targetServerId || !accountId) {
            setResults(null);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            // The last results stay on screen while the next query runs.
            setResults((previous) => ({ query: normalized, status: 'searching', documentsCoverage: previous?.documentsCoverage ?? null,
                documents: previous?.documents ?? [], sessions: previous?.sessions ?? [] }));
            void (async () => {
                try {
                    const result = await searchDaemonMemory({
                        serverId: targetServerId, accountId, machineId, query: normalized,
                        scope: { type: 'global' }, mode: 'auto', corpora: CORPORA, signal: controller.signal,
                    });
                    if (controller.signal.aborted) return;
                    if (!result.ok) {
                        setResults({ query: normalized, status: 'failed', documentsCoverage: null, documents: [], sessions: [] });
                        return;
                    }
                    setResults({
                        query: normalized,
                        status: 'ready',
                        documentsCoverage: result.documents ?? { state: 'unavailable' },
                        documents: result.hits.filter(isMemoryDocumentSearchHitV1),
                        sessions: result.hits.filter((hit): hit is MemorySearchHitV1 => !isMemoryDocumentSearchHitV1(hit)),
                    });
                } catch {
                    if (!controller.signal.aborted) setResults({ query: normalized, status: 'failed', documentsCoverage: null, documents: [], sessions: [] });
                }
            })();
        }, SEARCH_SETTLE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [accountId, machineId, normalized, targetServerId]);

    const openDocument = React.useCallback((hit: MemoryDocumentSearchHitV1) => {
        router.push(memoryDocumentSearchHitHref(hit) as never);
    }, [router]);
    const openSession = React.useCallback((hit: MemorySearchHitV1) => {
        fireAndForget(navigateToSession(hit.sessionId, { serverId, query: { jumpSeq: hit.seqFrom } }), { tag: 'MemorySearchPanel.session' });
    }, [navigateToSession, serverId]);

    const count = (results?.documents.length ?? 0) + (results?.sessions.length ?? 0);
    return (
        <View testID={testID}>
            <View style={styles.field}>
                <CompactSearchField
                    testID={`${testID}.input`}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('memoryContext.memory.searchPlaceholder')}
                    accessibilityLabel={t('memoryContext.memory.search')}
                    editable={target !== null}
                    autoFocus
                    trailing={results && results.status !== 'failed' && normalized.length >= MIN_QUERY_LENGTH ? (
                        <Text style={styles.count}>{t('memoryContext.memory.resultCount', { count })}</Text>
                    ) : undefined}
                />
            </View>
            {target === null ? (
                <SurfaceFreshnessLine testID={`${testID}.unavailable`} tone="warning" reason={t('memoryContext.memory.searchUnavailable')} />
            ) : results?.status === 'failed' ? (
                <SurfaceFreshnessLine testID={`${testID}.failed`} tone="warning" reason={t('memoryContext.memory.offline')} />
            ) : null}
            {results?.documentsCoverage && results.documentsCoverage.state !== 'ready' ? (
                <SurfaceFreshnessLine testID={`${testID}.documentsCoverage`}
                    busy={results.documentsCoverage.state === 'pending'}
                    tone={results.documentsCoverage.state === 'unavailable' ? 'warning' : 'neutral'}
                    reason={results.documentsCoverage.state === 'pending'
                        ? `${t('memoryContext.memory.remembered')} · ${t('common.loading')}`
                        : t('memoryContext.memory.documentSearchUnavailable')} />
            ) : null}
            {results && results.documents.length > 0 ? (
                <>
                    <GroupLabel label={t('memoryContext.memory.remembered')} count={results.documents.length} />
                    {results.documents.map((hit, index) => {
                        const where = typeof hit.location === 'object' ? memoryTopicLabel(hit.location.title)
                            : hit.location === 'archive' ? t('memoryContext.memory.archive') : null;
                        return (
                            <Item
                                key={`${hit.ref.artifactId}:${hit.factId ?? index}`}
                                testID={`${testID}.remembered.${index}`}
                                title={hit.summary}
                                titleLines={2}
                                titleStyle={hit.location === 'archive' ? styles.retired : undefined}
                                subtitle={where ?? undefined}
                                showChevron={false}
                                onPress={() => openDocument(hit)}
                            />
                        );
                    })}
                </>
            ) : null}
            {results && results.sessions.length > 0 ? (
                <>
                    <GroupLabel label={t('memoryContext.memory.pastSessions')} count={results.sessions.length} />
                    {results.sessions.map((hit, index) => (
                        <SessionHitRow
                            key={`${hit.sessionId}:${hit.seqFrom}`}
                            testID={`${testID}.session.${index}`}
                            hit={hit}
                            serverId={serverId}
                            onOpen={openSession}
                        />
                    ))}
                </>
            ) : null}
            {results?.status === 'ready' && results.documentsCoverage?.state === 'ready' && count === 0 ? (
                <Text testID={`${testID}.empty`} style={styles.hint}>{t('memoryContext.memory.noResults', { query: results.query })}</Text>
            ) : results === null && target !== null ? (
                <Text style={styles.hint}>{t('memoryContext.memory.searchHint')}</Text>
            ) : null}
        </View>
    );
});

function GroupLabel(props: Readonly<{ label: string; count: number }>) {
    const styles = stylesheet;
    return (
        <Text style={styles.group} accessibilityRole="header">
            {props.label}
            <Text style={styles.groupCount}>{`  ${props.count}`}</Text>
        </Text>
    );
}

const SessionHitRow = React.memo(function SessionHitRow(props: Readonly<{
    testID: string;
    hit: MemorySearchHitV1;
    serverId: string;
    onOpen: (hit: MemorySearchHitV1) => void;
}>) {
    const { hit, onOpen } = props;
    // Row-local: the hit's own Session title only.
    const name = useSessionSelector(hit.sessionId, props.serverId, (session) => (session ? getSessionName(session, props.serverId) : null));
    return (
        <Item
            testID={props.testID}
            icon={<Icon name="chat-circle" />}
            title={name ?? hit.summary}
            subtitle={name ? hit.summary : undefined}
            subtitleLines={2}
            detail={formatMemoryDate(hit.createdAtToMs)}
            showChevron={false}
            onPress={() => onOpen(hit)}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    field: {
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingBottom: 6,
    },
    count: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    group: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingTop: 10,
        paddingBottom: 2,
    },
    groupCount: {
        ...Typography.default(),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    hint: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        paddingTop: 8,
    },
    retired: {
        color: theme.colors.text.tertiary,
    },
}));
