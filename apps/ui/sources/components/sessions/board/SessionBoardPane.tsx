import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { readSessionSurfaceNoteTextV1 } from '@happier-dev/protocol/sessions/board';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import {
    type SessionBoardMountHost,
    type SessionBoardPrimaryMountResolver,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import { SessionBoardSurface } from './SessionBoardSurface';
import type { SessionWidgetDensity } from './SessionWidgetHost';
import { SessionBoardNoteEditorCard } from './note/SessionBoardNoteEditorCard';
import { SessionBoardHostedHtmlEditorCard } from './hostedHtml/SessionBoardHostedHtmlEditorCard';
import { useSessionBoardHostActionBindings } from './useSessionBoardHostActionBindings';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { useSessionCompanionController } from '@/components/sessions/companion/state/useSessionCompanionController';
import {
    applySessionCompanionMutationWithNotice,
    buildSessionPresentationNoticeKeyPrefix,
    showSessionBoardItemInCompanion,
} from '@/components/sessions/companion/presentation/sessionCompanionPresentationAdapter';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionBoardContinuity } from './SessionBoardContinuity';
import { useMountedSessionBoardController } from './SessionBoardControllerProvider';
import { useSessionCompanionRevealPort } from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';

/**
 * The Board placement wrapper every host mounts.
 *
 * Hosts supply their placement, density and layout. This component owns no pane
 * state, no navigation and no record transport: it consumes the exact-Session
 * shell controller and renders either the shared Board surface or one truthful
 * unavailable card.
 */

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

const NOOP_OPEN_COMPANION = () => {};
const NO_PRIMARY_MOUNT: SessionBoardPrimaryMountResolver = () => null;

export type SessionBoardPaneProps = Readonly<{
    sessionId: string;
    session?: Session;
    /** The captured Home for this Session; Board never consults the focused Home. */
    serverId?: string | null;
    host: SessionBoardMountHost;
    resolvePrimaryHost: SessionBoardPrimaryMountResolver;
    pluginRuntime?: SessionPluginRuntimeState;
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime;
    density: SessionWidgetDensity;
    layout: 'grid' | 'single';
    /** Compact sidebar projection: navigation only; mutations live in Details. */
    interaction?: 'workspace' | 'navigation';
    /**
     * This placement is kept mounted for content, scroll and view continuity but
     * is not the one a person is looking at. It renders its Board unchanged and
     * owns no interaction: no editor, no picker, no mutation controls and no
     * draft-guard registration. Unlike `interaction: 'navigation'` this is not a
     * different projection — density, layout and selected view are untouched.
     */
    retained?: boolean;
    /** Hand an item to the placement that can run it (Details, or the mobile Board). */
    onOpenItemHere?: (itemId: string) => void;
    /** Open the canonical Board Details destination without selecting an item. */
    onOpenBoardDetails?: () => void;
    /** Open an item's canonical expanded/full-content route in this host. */
    onReadFullItem?: (itemId: string) => void;
    /** Render one item's expanded route instead of the Board grid. */
    focusedItemId?: string | null;
    /** Leave the expanded item route and return to the Board. */
    onLeaveFocusedItem?: () => void;
    testID?: string;
}>;

export function SessionBoardPane(props: SessionBoardPaneProps): React.ReactElement {
    const styles = stylesheet;
    const testID = props.testID ?? 'session-board-pane';
    const boardAddress = React.useMemo(
        () => normalizeSessionAddress(props.serverId ?? null, props.sessionId),
        [props.serverId, props.sessionId],
    );
    const mounted = useMountedSessionBoardController(boardAddress);
    const binding = mounted?.binding ?? null;
    const controller = mounted?.controller ?? null;
    const actions = mounted?.actions ?? null;
    // The Session shell's exact-address owner wins whenever mounted. Optional
    // props exist only for isolated/direct hosts; allowing them to override the
    // shell would recreate the old Details/mobile runtime split-brain.
    const pluginRuntime = mounted?.pluginRuntime ?? props.pluginRuntime;
    const callerHostedHtmlRuntime = mounted?.callerHostedHtmlRuntime ?? props.callerHostedHtmlRuntime;
    const installedWidgetCandidates = mounted?.installedWidgetCandidates ?? [];
    const companionReveal = useSessionCompanionRevealPort(boardAddress);
    const companion = useSessionCompanionController({
        sessionId: props.sessionId,
        serverId: props.serverId ?? null,
        openFullSurface: companionReveal?.openFullSurface ?? NOOP_OPEN_COMPANION,
    });
    const companionWidgetIds = React.useMemo(() => new Set(
        companion.preference.items.flatMap((item) => item.kind === 'widget' ? [item.widgetId] : []),
    ), [companion.preference.items]);
    const companionNoticeKeyPrefix = React.useMemo(() => buildSessionPresentationNoticeKeyPrefix(
        normalizeSessionAddress(props.serverId ?? null, props.sessionId),
        props.sessionId,
    ), [props.serverId, props.sessionId]);
    const addToCompanion = React.useCallback((itemId: string) => {
        if (!companionReveal) return;
        showSessionBoardItemInCompanion({
            companion,
            publishNotice: publishPresentationNotice,
            noticeKeyPrefix: companionNoticeKeyPrefix,
            itemId,
            revealAfterMutation: companionReveal.revealAfterMutation,
        });
    }, [companion, companionNoticeKeyPrefix, companionReveal]);
    const removeFromCompanion = React.useCallback((itemId: string) => {
        applySessionCompanionMutationWithNotice({
            companion,
            publishNotice: publishPresentationNotice,
            noticeKeyPrefix: companionNoticeKeyPrefix,
            kind: 'companion.item.remove',
            message: t('sessionBoard.companion.notices.removed'),
            apply: (current) => current.removeItem({ kind: 'widget', widgetId: itemId }),
        });
    }, [companion, companionNoticeKeyPrefix]);
    const navigationOnly = props.interaction === 'navigation';
    const retained = props.retained === true;
    // The compact sidebar and a retained background tab are read-only for
    // different reasons but by the same rule: exactly one visible workspace
    // placement owns the Board's single draft, picker and mutation controls.
    const interactive = !navigationOnly && !retained;
    const continuity = useSessionBoardContinuity(boardAddress);
    const editorOwnerId = React.useId();
    const activateEditor = continuity?.editorHandoff.activate;
    const deactivateEditor = continuity?.editorHandoff.deactivate;
    const registerEditorFlushWithContinuity = continuity?.editorHandoff.registerFlush;
    React.useEffect(() => {
        if (!activateEditor || !deactivateEditor) return;
        if (interactive) activateEditor(editorOwnerId);
        else deactivateEditor(editorOwnerId);
        return () => deactivateEditor(editorOwnerId);
    }, [activateEditor, deactivateEditor, editorOwnerId, interactive]);
    const ownsEditor = continuity
        ? continuity.editorHandoff.activeOwnerId === editorOwnerId
        : interactive;
    const unregisterEditorFlushRef = React.useRef<(() => void) | null>(null);
    const registerEditorFlush = React.useCallback((flush: (() => void | Promise<void>) | null) => {
        unregisterEditorFlushRef.current?.();
        unregisterEditorFlushRef.current = null;
        if (flush && registerEditorFlushWithContinuity) {
            unregisterEditorFlushRef.current = registerEditorFlushWithContinuity(editorOwnerId, flush);
        }
    }, [editorOwnerId, registerEditorFlushWithContinuity]);
    React.useEffect(() => () => unregisterEditorFlushRef.current?.(), []);
    const noteDraftGuardRef = React.useRef<((transition: () => void | Promise<void>) => Promise<boolean>) | null>(null);
    const unregisterDraftGuardRef = React.useRef<(() => void) | null>(null);
    const registerDraftGuard = React.useCallback((guard: ((transition: () => void | Promise<void>) => Promise<boolean>) | null) => {
        unregisterDraftGuardRef.current?.();
        unregisterDraftGuardRef.current = null;
        noteDraftGuardRef.current = guard;
        if (guard && continuity) unregisterDraftGuardRef.current = continuity.draftGuard.register(guard);
    }, [continuity]);
    React.useEffect(() => () => unregisterDraftGuardRef.current?.(), []);
    const runDraftGuardedTransition = React.useCallback((transition: () => void | Promise<void>) => {
        if (continuity) return continuity.draftGuard.run(transition);
        const guard = noteDraftGuardRef.current;
        if (guard) return guard(transition);
        const result = transition();
        return result ? result.then(() => true) : true;
    }, [continuity]);

    // Plugin and encryption recovery are owned by the mounted Board controller
    // (`SessionBoardControllerProvider`), which holds the exact Session Home this
    // placement must establish before navigating. Duplicating them here made
    // `controller.supports('item.prepareEncryption')` permanently false, so the
    // Board's own locked-layout card drew a recovery it could not perform.
    const resolveActionBinding = useSessionBoardHostActionBindings({
        serverId: props.serverId ?? null,
        sessionId: props.sessionId,
        enabled: binding?.status === 'ready'
            && binding.snapshot.reachability === 'reachable',
    });

    if (!binding || !controller || binding.status === 'unavailable') {
        // Retry is offered only when this exact mounted owner actually published a
        // refresh; a card that draws "Try again" over an absent handler is worse
        // than a card that quietly explains the state.
        const retry = binding?.status === 'unavailable'
            && (binding.reason === 'offline' || binding.reason === 'server_error' || binding.reason === 'invalid_response')
            ? binding.refresh
            : undefined;
        return (
            <View style={styles.root} testID={testID}>
                <SurfaceStateCard
                    testID={`${testID}-unavailable`}
                    kind="unavailable"
                    title={t('sessionBoard.board.unavailable.title')}
                    reason={t('sessionBoard.board.unavailable.reason')}
                    diagnosticCode={binding?.status === 'unavailable' ? binding.reason : 'session_board_controller_unavailable'}
                    {...(retry ? { action: { label: t('common.retry'), onPress: retry } } : {})}
                    accessibilitySemantics="status"
                />
            </View>
        );
    }

    const draft = controller.noteDraft;
    const hostedHtmlDraft = controller.hostedHtmlDraft;
    const snapshot = binding.snapshot;
    const recoveryItemId = draft?.itemId ?? hostedHtmlDraft?.itemId;
    const draftProjection = recoveryItemId ? snapshot.itemsById.get(recoveryItemId) : undefined;
    const recoveryObservation = {
        state: snapshot.loading === 'refreshing' || snapshot.freshness !== 'fresh' || snapshot.incomplete
            ? 'refreshing' as const
            : 'settled' as const,
        revision: draftProjection?.revision ?? null,
        item: draftProjection?.state.kind === 'ready' ? draftProjection.state.item : null,
    };
    const noteEditor = ownsEditor && draft && actions ? (
        <SessionBoardNoteEditorCard
            key={`${draft.itemId}:${draft.expectedItemRevision ?? 'new'}`}
            sessionId={props.sessionId}
            itemId={draft.itemId}
            expectedItemRevision={draft.expectedItemRevision}
            {...(draft.placement ? { placement: draft.placement } : {})}
            initialTitle={draft.initialTitle}
            initialBody={draft.initialBody}
            {...(draft.baseItem ? { baseItem: draft.baseItem } : {})}
            latestRevision={snapshot.itemsById.get(draft.itemId)?.revision ?? null}
            latestBody={readLatestNoteBody(snapshot, draft.itemId)}
            recoveryObservation={recoveryObservation}
            requestRecoveryRefresh={binding.refresh}
            // Freshness is not permission: only reachability pauses the Save.
            reachable={snapshot.reachability === 'reachable' && snapshot.canEdit}
            approvalPending={mounted?.approvalPending === true}
            actions={actions}
            {...(mounted ? { requestApprovalContinuation: mounted.requestApprovalContinuation } : {})}
            onCancel={controller.closeNoteDraft}
            onSaved={controller.onNoteSaved}
            guardNavigation
            onGuardChange={registerDraftGuard}
            onContinuityFlushChange={registerEditorFlush}
        />
    ) : null;

    const hostedHtmlEditor = ownsEditor && hostedHtmlDraft && actions && callerHostedHtmlRuntime ? (
        <SessionBoardHostedHtmlEditorCard
            key={`${hostedHtmlDraft.itemId}:${hostedHtmlDraft.expectedItemRevision ?? 'new'}`}
            sessionId={props.sessionId}
            itemId={hostedHtmlDraft.itemId}
            expectedItemRevision={hostedHtmlDraft.expectedItemRevision}
            initialTitle={hostedHtmlDraft.initialTitle}
            initialHtml={hostedHtmlDraft.initialHtml}
            {...(hostedHtmlDraft.baseItem ? { baseItem: hostedHtmlDraft.baseItem } : {})}
            {...(hostedHtmlDraft.placement ? { placement: hostedHtmlDraft.placement } : {})}
            latestRevision={snapshot.itemsById.get(hostedHtmlDraft.itemId)?.revision ?? null}
            latestHtml={readLatestHostedHtml(snapshot, hostedHtmlDraft.itemId)}
            reachable={snapshot.reachability === 'reachable' && snapshot.canEdit}
            approvalPending={mounted?.approvalPending === true}
            recoveryObservation={recoveryObservation}
            requestRecoveryRefresh={binding.refresh}
            actions={actions}
            {...(mounted ? { requestApprovalContinuation: mounted.requestApprovalContinuation } : {})}
            onCancel={controller.closeHostedHtmlDraft}
            onSaved={controller.onHostedHtmlSaved}
            onGuardChange={registerDraftGuard}
            onContinuityFlushChange={registerEditorFlush}
        />
    ) : null;
    const editor = noteEditor ?? hostedHtmlEditor;


    // Add is a complete one-press intent only when the canonical preference
    // realm, exact shell destination and Board currentness owners all agree.
    // Remove remains a safe local inverse while the shared Board is unreachable.
    const canAddToCompanion = companion.availability === 'ready'
        && companionReveal !== null
        && snapshot.reachability === 'reachable';

    return (
        <View style={styles.root} testID={testID}>
            <SessionBoardSurface
                sessionId={props.sessionId}
                serverId={props.serverId}
                {...(props.session ? { session: props.session } : {})}
                controller={controller}
                host={props.host}
                // A host that cannot reach its Home runs nothing.
                resolvePrimaryHost={snapshot.reachability === 'offline' ? NO_PRIMARY_MOUNT : props.resolvePrimaryHost}
                density={props.density}
                layout={props.layout}
                resolveActionBinding={resolveActionBinding}
                navigationOnly={navigationOnly}
                retained={retained}
                onBodyEligibilityChange={mounted?.onBodyEligibilityChange}
                {...(interactive && mounted ? {
                    onViewFocusTargetChange: mounted.onViewFocusTargetChange,
                    onViewActionsFocusTargetChange: mounted.onViewActionsFocusTargetChange,
                    viewActionsFocusTargetRef: mounted.viewActionsFocusTargetRef,
                } : {})}
                {...(props.onOpenItemHere ? { onOpenItemHere: props.onOpenItemHere } : {})}
                {...(props.onOpenBoardDetails ? { onOpenBoardDetails: props.onOpenBoardDetails } : {})}
                {...(pluginRuntime ? { pluginRuntime } : {})}
                {...(callerHostedHtmlRuntime ? { callerHostedHtmlRuntime } : {})}
                {...(props.onReadFullItem
                    ? { onReadFullItem: props.onReadFullItem }
                    : navigationOnly && props.onOpenItemHere
                        ? { onReadFullItem: props.onOpenItemHere }
                        : {})}
                {...(!retained && canAddToCompanion ? {
                    companionItemIds: companionWidgetIds,
                    onAddToCompanion: addToCompanion,
                    onRemoveFromCompanion: removeFromCompanion,
                } : !retained && companion.availability === 'ready' ? {
                    companionItemIds: companionWidgetIds,
                    onRemoveFromCompanion: removeFromCompanion,
                } : {})}
                {...(props.focusedItemId ? { focusedItemId: props.focusedItemId } : {})}
                {...(props.onLeaveFocusedItem
                    ? { onLeaveFocusedItem: () => { void runDraftGuardedTransition(props.onLeaveFocusedItem!); } }
                    : {})}
                testID={`${testID}-surface`}
                {...(editor ? { editor } : {})}
                {...(interactive ? { addCandidates: installedWidgetCandidates } : {})}
            />
        </View>
    );
}

/** The current record's note body, shown read-only beside the draft after a conflict. */
function readLatestNoteBody(snapshot: SessionBoardSnapshot, itemId: string): string | null {
    const latest = snapshot.itemsById.get(itemId);
    if (latest?.state.kind !== 'ready') return null;
    const source = latest.state.item.source;
    return source.kind === 'declarative' ? readSessionSurfaceNoteTextV1(source.document) : null;
}

/** Current authoritative HTML, revealed read-only before a deliberate conflict retry. */
function readLatestHostedHtml(snapshot: SessionBoardSnapshot, itemId: string): string | null {
    const latest = snapshot.itemsById.get(itemId);
    if (latest?.state.kind !== 'ready') return null;
    const source = latest.state.item.source;
    return source.kind === 'hostedHtml' && source.source.kind === 'html'
        ? source.source.html
        : null;
}
