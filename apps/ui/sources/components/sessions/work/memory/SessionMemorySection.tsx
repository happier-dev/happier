import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { selectMemoryTargetV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { MemoryDocumentBody } from '@/components/memory/MemoryDocumentBody';
import { MemorySearchPanel } from '@/components/memory/MemorySearchPanel';
import { useMemoryDocument } from '@/components/memory/useMemoryDocument';
import { useMemoryCreationReceipt } from '@/components/memory/useMemoryCreationReceipt';
import { SessionIntentConflictLine } from '@/components/sessions/work/SessionIntentConflictLine';
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
import type { SessionContextLayers } from '../context/useSessionContextLayers';
import { SessionContextLayersObservation } from '../context/SessionContextLayersScope';

/** Key facts shown in the pane before "Show all N" (lab `c-mem A`). */
const COLLAPSED_FACTS = 5;

type MemorySelection = Readonly<{
    /** Coverage of the layer that decides which document this Session writes to. */
    status: 'loading' | 'ready' | 'unavailable';
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
    const own = layers.session.find(row => row.entry.id === 'session.memory' && row.entry.ref.kind === 'doc');
    const statusWithEntryCoverage = <T extends 'none' | 'pending' | 'ready' | 'unavailable'>(status: T,
        rows: SessionContextLayers['account']): T | 'pending' | 'unavailable' => status === 'unavailable'
            || rows.some(row => row.presentationStatus === 'unavailable') ? 'unavailable'
            : rows.some(row => row.presentationStatus === 'loading') ? 'pending' : status;
    const projectStatus = statusWithEntryCoverage(layers.project.status, layers.project.rows);
    const accountStatus = statusWithEntryCoverage(layers.accountStatus, layers.account);
    const selection = selectMemoryTargetV1({ isBot: layers.isBot,
        botRef: own ? { kind: 'doc', artifactId: own.entry.ref.artifactId, serverId: own.entry.ref.serverId ?? serverId } : null,
        project: { status: projectStatus, ref: refOf(layers.project.rows) },
        account: { status: accountStatus, ref: refOf(layers.account) },
    });
    const status = layers.isBot && own?.presentationStatus === 'loading' ? 'loading'
        : layers.isBot && own?.presentationStatus === 'unavailable' ? 'unavailable'
            : selection.resolving && selection.scope === 'project' ? projectStatus === 'unavailable' ? 'unavailable' : 'loading'
                : selection.resolving && selection.scope === 'account' ? accountStatus === 'unavailable' ? 'unavailable' : 'loading'
                    : 'ready';
    return { ...selection, status };
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
    // A pending choice belongs to this Session, including while another Session opens in Info.
    return <SessionContextLayersObservation params={{ sessionId: session.id, serverId, ownerMetadata, metadataVersion: session.metadataVersion }}>
        {layers => <SessionMemoryBody key={JSON.stringify([serverId, session.id])} session={session} serverId={serverId} layers={layers} />}
    </SessionContextLayersObservation>;
});

const SessionMemoryBody = React.memo(function SessionMemoryBody(props: Readonly<{
    session: Session;
    serverId: string;
    layers: SessionContextLayers;
}>) {
    const { session, serverId } = props;
    const { layers } = props;
    const enabled = layers.memoryEnabled;
    const preparationScope = React.useMemo(() => ({ type: 'session' as const, sessionId: session.id }), [session.id]);
    const preparationBasis = React.useMemo(() => JSON.stringify([session.metadataVersion, layers]), [layers, session.metadataVersion]);
    const selection = React.useMemo(() => selectSessionMemory(layers, serverId), [layers, serverId]);
    const { receipt, ref, onCreatedMemory } = useMemoryCreationReceipt({
        serverId, scopeKey: JSON.stringify([session.id, selection.scope]), attachedRef: selection.ref,
    });
    // The Action's saved receipt proves this document even while its attachment cannot be resolved.
    const resolving = selection.status === 'loading' && receipt === null;
    const unavailable = selection.status === 'unavailable' && receipt === null;
    const refreshing = selection.scope === 'project' && layers.project.refreshing;
    const source = useMemoryDocument({ ref, serverId, enabled });
    // Keep the renderer's draft/notice mounted through the owning catalog's read; unknown is not empty.
    const displayedSource = React.useMemo(() => resolving
        ? { ...source, status: 'loading' as const, view: null, target: null, stale: false }
        : unavailable ? { ...source, status: 'unavailable' as const, view: null, target: null, stale: false }
            : refreshing ? { ...source, target: null } : source, [refreshing, resolving, source, unavailable]);
    const navigateToSession = useNavigateToSession();
    const openSession = React.useCallback((ref: Readonly<{ serverId: string; sessionId: string; messageId?: string }>) => {
        fireAndForget(navigateToSession(ref.sessionId, { serverId: ref.serverId, messageId: ref.messageId }), { tag: 'SessionMemorySection.source' });
    }, [navigateToSession]);
    // The choice being saved: the switch shows it at once, so a slow Home never leaves it looking stuck.
    const [pendingChoice, setPendingChoice] = React.useState<boolean | null>(null);
    const [searching, setSearching] = React.useState(false);
    const [composing, setComposing] = React.useState(false);
    const sessionTarget = React.useMemo<MemorySessionTarget>(
        () => ({ sessionId: session.id, serverId, expectedMetadataRevision: session.metadataVersion }),
        [serverId, session.id, session.metadataVersion],
    );

    // A refused switch says so in the section, beside the switch it did not move, until the next attempt.
    const [refused, setRefused] = React.useState(false);
    // A choice the Session was no longer at the revision for is held, not lost: the switch keeps the current value.
    const [heldChoice, setHeldChoice] = React.useState<boolean | null>(null);
    const setEnabled = React.useCallback((next: boolean) => {
        if (pendingChoice !== null) return;
        setPendingChoice(next);
        setRefused(false);
        setHeldChoice(null);
        fireAndForget((async () => {
            try {
                const outcome = readMemoryActionOutcome(await memoryDocumentActions.setSessionMemory(sessionTarget, next));
                if (outcome === 'conflict') setHeldChoice(next);
                else if (outcome === 'refused') setRefused(true);
            } catch {
                setRefused(true);
            } finally {
                setPendingChoice(null);
            }
        })(), { tag: 'SessionMemorySection.setEnabled' });
    }, [pendingChoice, sessionTarget]);

    const shownEnabled = pendingChoice ?? enabled;
    const factCount = displayedSource.view?.facts?.length ?? 0;
    const documentAccess = displayedSource.view?.access ?? null;
    const shared = displayedSource.stale ? null : displayedSource.view?.shared ?? null;
    const readOnly = refreshing || ref !== null && (documentAccess === null || documentAccess === 'view');
    const canRemember = !readOnly && Boolean(displayedSource.target || (!ref && !resolving && displayedSource.status === 'none'));
    const footer = resolving || unavailable || (ref && (documentAccess === null || shared === null)) ? undefined : shared
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
            icon="cpu"
            // Closed in Setup it reads like the lab: "On · 16", the count once the document is read.
            summary={!shownEnabled ? t('common.off')
                : factCount > 0 ? joinHappierFacts(t('common.on'), String(factCount)) : t('common.on')}
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
            {heldChoice !== null ? (
                <SessionIntentConflictLine
                    testID="session-work-memory.conflict"
                    subject={t('memoryContext.memory.title')}
                    current={enabled ? t('common.on') : t('common.off')}
                    onApply={() => setEnabled(heldChoice)}
                    onKeep={() => setHeldChoice(null)}
                />
            ) : refused ? (
                <SurfaceFreshnessLine testID="session-work-memory.refused" tone="warning" reason={t('memoryContext.session.refused')} />
            ) : null}
            {/* Search takes the section's body: what you look through, not the switch that turns it on. */}
            {searching && enabled && !resolving ? null : <Item
                testID="session-work-memory.enabled"
                title={t('memoryContext.session.useMemory')}
                subtitle={!shownEnabled ? t('memoryContext.session.offDescription')
                    : layers.isBot ? t('memoryContext.session.onForBots') : t('memoryContext.session.onDescription')}
                showChevron={false}
                showDivider={false}
                rightElement={(
                    <Switch
                        testID="session-work-memory.enabled.switch"
                        value={shownEnabled}
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
                    preparationScope={preparationScope}
                    preparationBasis={preparationBasis}
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
