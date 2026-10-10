import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { MemoryDocumentBody } from '@/components/memory/MemoryDocumentBody';
import { MemorySearchPanel } from '@/components/memory/MemorySearchPanel';
import { useMemoryDocument } from '@/components/memory/useMemoryDocument';
import { useMemoryCreationReceipt } from '@/components/memory/useMemoryCreationReceipt';
import { WorkSection, WorkSectionEmptyLine } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    memoryDocumentActions,
    readMemoryActionOutcome,
    type MemorySessionTarget,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { resolveSessionInstructionsAccess } from '../instructions/SessionInstructionsSection';
import { useSessionContextLayers, type SessionContextLayers } from '../context/useSessionContextLayers';

/** Key facts shown in the pane before "Show all N" (lab `c-mem A`). */
const COLLAPSED_FACTS = 5;

type MemorySelection = Readonly<{
    /** Still resolving which document this Session writes to (its Project's rows are being read). */
    resolving: boolean;
    ref: PromptDocArtifactRefV1 | null;
    scope: 'session' | 'project' | 'account';
}>;

/**
 * The document this Session remembers into, by the same rule the `memory.remember` Action applies:
 * a Bot → its own memory; an ordinary Session → Project memory when it has one, else Account memory.
 */
export function selectSessionMemory(layers: SessionContextLayers, serverId: string): MemorySelection {
    const refOf = (rows: SessionContextLayers['account']) => {
        const row = rows.find((candidate) => candidate.kind === 'memory' && candidate.entry.ref.kind === 'doc');
        return row ? { kind: 'doc' as const, artifactId: row.entry.ref.artifactId, serverId: row.entry.ref.serverId ?? serverId } : null;
    };
    if (layers.isBot) {
        const own = layers.session.find((row) => row.entry.id === 'session.memory' && row.entry.ref.kind === 'doc');
        return {
            resolving: false,
            scope: 'session',
            ref: own ? { kind: 'doc', artifactId: own.entry.ref.artifactId, serverId: own.entry.ref.serverId ?? serverId } : null,
        };
    }
    if (layers.project.status === 'pending' || layers.project.status === 'unavailable'
        || layers.project.rows.some(row => row.kind === 'unknown')) return { resolving: true, ref: null, scope: 'project' };
    const project = refOf(layers.project.rows);
    if (project) return { resolving: false, ref: project, scope: 'project' };
    if (layers.accountStatus !== 'ready' || layers.account.some(row => row.kind === 'unknown')) {
        return { resolving: true, ref: null, scope: 'account' };
    }
    return { resolving: false, ref: refOf(layers.account), scope: 'account' };
}

/**
 * Work › Memory (plan 65 §8, lab `c-mem A/O/S/W`, D45/D48): the Session's one memory switch, then what
 * it remembers — the index first (key facts, then topics, each opening its own page) — drawn by the
 * shared memory renderer, with one search over memory and past sessions. The switch is the public
 * `session.memory.set` Action; facts are the `memory.*` Actions. Only the Session's owner sees it.
 */
export const SessionMemorySection = React.memo(function SessionMemorySection(props: Readonly<{
    session: Session;
    serverId: string;
}>) {
    const { session, serverId } = props;
    const access = resolveSessionInstructionsAccess(session);
    const ownerMetadata = React.useMemo(() => readSessionOwnerMetadataView(session), [session]);
    if (access !== 'readable' || !ownerMetadata) return null;
    return <SessionMemoryBody session={session} serverId={serverId} ownerMetadata={ownerMetadata} />;
});

const SessionMemoryBody = React.memo(function SessionMemoryBody(props: Readonly<{
    session: Session;
    serverId: string;
    ownerMetadata: unknown;
}>) {
    const { session, serverId } = props;
    const layers = useSessionContextLayers({
        sessionId: session.id, serverId, ownerMetadata: props.ownerMetadata, metadataVersion: session.metadataVersion,
    });
    const enabled = layers.memoryEnabled;
    const selection = React.useMemo(() => selectSessionMemory(layers, serverId), [layers, serverId]);
    const { receipt, ref, onCreatedMemory } = useMemoryCreationReceipt({
        serverId, scopeKey: JSON.stringify([session.id, selection.scope]), attachedRef: selection.ref,
    });
    // The Action's saved receipt proves this document even while its attachment cannot be resolved.
    const resolving = selection.resolving && receipt === null;
    const source = useMemoryDocument({ ref, serverId, enabled });
    // Keep the renderer's draft/notice mounted through the owning catalog's read; unknown is not empty.
    const displayedSource = React.useMemo(() => resolving
        ? { ...source, status: 'loading' as const, view: null, target: null, stale: false } : source, [resolving, source]);
    const navigateToSession = useNavigateToSession();
    const openSession = React.useCallback((ref: Readonly<{ serverId: string; sessionId: string }>) => {
        fireAndForget(navigateToSession(ref.sessionId, { serverId: ref.serverId }), { tag: 'SessionMemorySection.source' });
    }, [navigateToSession]);
    const [saving, setSaving] = React.useState(false);
    const [searching, setSearching] = React.useState(false);
    const [composing, setComposing] = React.useState(false);
    const sessionTarget = React.useMemo<MemorySessionTarget>(
        () => ({ sessionId: session.id, serverId, expectedMetadataRevision: session.metadataVersion }),
        [serverId, session.id, session.metadataVersion],
    );

    // A refused switch says so in the section, beside the switch it did not move, until the next attempt.
    const [refused, setRefused] = React.useState(false);
    const setEnabled = React.useCallback((next: boolean) => {
        setSaving(true);
        setRefused(false);
        fireAndForget((async () => {
            try {
                const outcome = readMemoryActionOutcome(await memoryDocumentActions.setSessionMemory(sessionTarget, next));
                if (outcome === 'refused' || outcome === 'conflict') setRefused(true);
            } catch {
                setRefused(true);
            } finally {
                setSaving(false);
            }
        })(), { tag: 'SessionMemorySection.setEnabled' });
    }, [sessionTarget]);

    const documentAccess = displayedSource.view?.access ?? null;
    const shared = documentAccess !== null && documentAccess !== 'owner';
    const readOnly = ref !== null && (documentAccess === null || documentAccess === 'view');
    const canRemember = !readOnly && Boolean(displayedSource.target || (!ref && !resolving && displayedSource.status === 'none'));
    const footer = resolving || (ref && documentAccess === null) ? undefined : shared
        ? joinHappierFacts(t('memoryContext.memory.accessShared'), t('memoryContext.memory.writesAskFirst'))
        : joinHappierFacts(selection.scope === 'project' ? t('memoryContext.session.projectMemory')
            : selection.scope === 'account' ? t('memoryContext.session.yourMemory') : t('memoryContext.memory.accessPrivate'),
        // A Bot's own memory names who writes to it (lab `c-mem A`).
            layers.isBot ? t('memoryContext.memory.remembersWithoutAsking', { name: getSessionName(session, serverId) })
            : t('memoryContext.memory.writesWithoutAsking'));
    return (
        <WorkSection
            testID="session-work-memory"
            anatomy="page"
            title={t('memoryContext.memory.title')}
            count=""
            nativeID="memory"
            action={enabled ? (
                <View style={styles.actions}>
                    <IconButton
                        testID="session-work-memory.search"
                        iconName={searching ? 'x' : 'magnifying-glass'}
                        variant="plain"
                        accessibilityLabel={searching ? t('memoryContext.memory.closeSearch') : t('memoryContext.memory.search')}
                        tooltip={searching ? t('memoryContext.memory.closeSearch') : t('memoryContext.memory.search')}
                        expanded={searching}
                        onPress={() => { setSearching((open) => !open); setComposing(false); }}
                    />
                    {searching || !canRemember ? null : (
                        <IconButton
                            testID="session-work-memory.remember"
                            iconName="plus"
                            variant="plain"
                            accessibilityLabel={t('memoryContext.memory.remember')}
                            tooltip={t('memoryContext.memory.remember')}
                            disabled={resolving}
                            onPress={() => setComposing(true)}
                        />
                    )}
                </View>
            ) : null}
        >
            {refused ? (
                <SurfaceFreshnessLine testID="session-work-memory.refused" tone="warning" reason={t('memoryContext.session.refused')} />
            ) : null}
            {/* Search takes the section's body: what you look through, not the switch that turns it on. */}
            {searching && enabled && !resolving ? null : <Item
                testID="session-work-memory.enabled"
                title={t('memoryContext.session.useMemory')}
                subtitle={!enabled ? t('memoryContext.session.offDescription')
                    : layers.isBot ? t('memoryContext.session.onForBots') : t('memoryContext.session.onDescription')}
                showChevron={false}
                showDivider={false}
                rightElement={(
                    <Switch
                        testID="session-work-memory.enabled.switch"
                        value={enabled}
                        disabled={saving}
                        onValueChange={setEnabled}
                        accessibilityLabel={t('memoryContext.session.useMemory')}
                    />
                )}
            />}
            {!enabled ? null : searching && !resolving ? (
                <MemorySearchPanel testID="session-work-memory.searchPanel" serverId={serverId} />
            ) : (
                <MemoryDocumentBody
                    testID="session-work-memory.doc"
                    source={displayedSource}
                    serverId={serverId}
                    collapsedFactCount={COLLAPSED_FACTS}
                    footer={footer}
                    readOnly={readOnly}
                    composing={composing}
                    onComposingChange={setComposing}
                    sessionTarget={ref || resolving ? null : sessionTarget}
                    onCreatedMemory={onCreatedMemory}
                    emptyText={t('memoryContext.session.emptyOn')}
                    renderEmpty={renderMemoryEmptyLine}
                    onOpenSession={openSession}
                />
            )}
        </WorkSection>
    );
});

/** Module scope: the document body's memo keeps its identity across the section's renders. */
function renderMemoryEmptyLine(line: Readonly<{ testID: string; text: string }>) {
    return <WorkSectionEmptyLine testID={line.testID} text={line.text} />;
}

const styles = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
}));
