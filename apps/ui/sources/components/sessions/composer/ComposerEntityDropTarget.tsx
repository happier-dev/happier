import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { useUnistyles } from 'react-native-unistyles';
import * as React from 'react';
import type { ComposerRefV1} from '@happier-dev/protocol/plugins/ui/composerRef';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { EntityDragKindV1, EntityDragScopeV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { useEntityDragDropRuntime, useEntityDropTarget, useEntityDropTargetState, TreeDropOutline,
    type WindowBounds, type WindowPointer } from '@/components/ui/treeDragDrop';
import type { MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { readExternalFileDragPointer, subscribeExternalFileDragPointer } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { readMountedComposerPresentationSnapshot, readMountedComposerAttachmentComposition } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readComposerSessionSuggestionItems } from '@/sync/domains/input/suggestionSession';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import type { ComposerReferenceSearchHost } from '@/components/autocomplete/composerSuggestionKinds';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';
import { resolveComposerEntityDrop } from './composerEntityDrop';
import { describeComposerEntityDropReason } from './composerEntityDropReason';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { resolveDestinationRefFromHref } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

/** Only this feedback leaf observes carry changes; typing and pointer frames stay separate. */
export function ComposerEntityDropTarget(props: Readonly<{
    id: string;
    scope: EntityDragScopeV1;
    refValue: ComposerRefV1;
    bounds: () => WindowBounds | null;
    /** The composer's whole block (status row and panel): the carried card keeps clear of it. */
    clearBounds?: () => WindowBounds | null;
    presented: boolean;
    editable: boolean;
    inputRef: React.RefObject<Pick<MultiTextInputHandle, 'offsetAtPoint' | 'setDropCaret'> | null>;
    externalFilesActive?: boolean;
    fileScope?: FileSuggestionScope | null;
    referenceHost?: ComposerReferenceSearchHost | null;
    kinds: readonly import('@/components/autocomplete/composerSuggestionKinds').ComposerSuggestionKindId[];
}>): React.ReactElement | null {
    const runtime = useEntityDragDropRuntime();
    const { theme } = useUnistyles();
    const navigation = useOptionalWorkspaceNavigation();
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);
    const platform = resolvePluginUiClientExecutablePlatform();
    // Carry frames reuse the canonical normalized map; they do not normalize
    // every plugin family or recompile attachment schemas while hovering.
    const dragSources = props.referenceHost?.pluginUiProjection.dragSourcesById ?? EMPTY_PLUGIN_UI_PROJECTION.dragSourcesById;
    const dropPosition = React.useRef<Readonly<{ pointer: WindowPointer; offset: number }> | null>(null);
    const current = React.useRef(props);
    current.current = props;
    React.useEffect(() => {
        let frame: ReturnType<typeof requestAnimationFrame> | null = null;
        let pending: object | null = null;
        const readPoint = () => {
            const snapshot = runtime.getSnapshot();
            if (snapshot.phase === 'carrying' && snapshot.targetId === props.id && snapshot.admission?.status === 'allowed') return runtime.getPointer();
            if (!current.current.externalFilesActive || !current.current.editable || !current.current.presented) return null;
            const point = readExternalFileDragPointer();
            const bounds = current.current.bounds();
            return point && bounds && point.x >= bounds.x && point.x <= bounds.x + bounds.width
                && point.y >= bounds.y && point.y <= bounds.y + bounds.height ? point : null;
        };
        const update = () => {
            pending = null;
            if (!readPoint()) {
                if (frame !== null) cancelAnimationFrame(frame);
                frame = null;
                current.current.inputRef.current?.setDropCaret(null);
                return;
            }
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                const point = readPoint();
                const handle = current.current.inputRef.current;
                if (!point || !handle) return;
                const request = {};
                pending = request;
                void handle.offsetAtPoint(point).then(offset => {
                    if (pending === request && current.current.inputRef.current === handle) handle.setDropCaret(offset);
                }, () => { if (pending === request) handle.setDropCaret(null); });
            });
        };
        const dispose = [runtime.subscribe(update), runtime.subscribePointer(update), subscribeExternalFileDragPointer(update)];
        update();
        return () => {
            pending = null;
            if (frame !== null) cancelAnimationFrame(frame);
            dispose.forEach(unsubscribe => unsubscribe());
            current.current.inputRef.current?.setDropCaret(null);
        };
    }, [runtime, props.id, props.externalFilesActive, props.editable, props.presented]);
    const acceptedKinds: EntityDragKindV1[] = ['workflow', 'work-board-widget', 'widget-area-instance'];
    if (props.kinds.includes('session')) acceptedKinds.push('session');
    if (props.kinds.includes('file')) acceptedKinds.push('repository-file', 'destination');
    if (props.kinds.includes('composerReference')) {
        for (const record of props.referenceHost?.projection.contributionIntrospection?.contributions ?? []) {
            if (record.contribution.kind === 'localId' && record.contribution.family === 'dragSources') {
                acceptedKinds.push(`plugin:${record.contribution.pluginId}/${record.contribution.localId}`);
            }
        }
    }
    for (const source of Object.values(dragSources)) {
        if (source.definition.composerAttachment) acceptedKinds.push(`plugin:${source.pluginId}/${source.definition.id}`);
    }
    const isCurrent = () => {
        const current = getActiveServerAccountScope();
        return props.presented && current?.serverId === props.scope.serverId && current.accountId === props.scope.accountId;
    };
    useEntityDropTarget(runtime, {
        id: props.id, scope: props.scope, acceptedKinds, getBounds: props.bounds,
        ...(props.clearBounds ? { getClearBounds: props.clearBounds } : {}), isCurrent,
        measureBounds: async pointer => {
            dropPosition.current = null;
            if (!pointer) return;
            const offset = await props.inputRef.current?.offsetAtPoint(pointer);
            if (typeof offset === 'number') dropPosition.current = { pointer, offset };
        },
        getDestinationKey: () => null,
        listDestinations: () => [{ destination: null, label: t('entityDragDrop.composer.mentionInComposer') }],
        resolve: ({ item, pointer }) => {
            const sessionId = props.refValue.kind === 'session' ? props.refValue.sessionId : null;
            return resolveComposerEntityDrop(item, {
                scope: props.scope, ref: props.refValue,
                at: pointer && dropPosition.current?.pointer.x === pointer.x && dropPosition.current.pointer.y === pointer.y
                    ? { kind: 'offset', offset: dropPosition.current.offset } : { kind: 'caret' },
                itemLabel: runtime.describeSource(runtime.getSnapshot().sourceId ?? '')?.title,
                snapshot: (() => {
                    const snapshot = readMountedComposerPresentationSnapshot({ scope: props.scope, ref: props.refValue });
                    return snapshot && !props.editable ? { ...snapshot, state: { ...snapshot.state, editable: false } } : snapshot;
                })(),
                sessions: item.kind === 'session' ? readComposerSessionSuggestionItems({
                    serverId: props.scope.serverId, currentSessionId: sessionId, candidateSessionId: item.address.sessionId,
                }, readSessionRecordingVisibility()) : [],
                workspace: props.fileScope ?? (sessionId ? resolveWorkspaceTargetForSession({ serverId: props.scope.serverId, sessionId }) : null),
                referenceHost: props.referenceHost,
                platform,
                dragSources,
                attachmentComposition: readMountedComposerAttachmentComposition({ scope: props.scope, ref: props.refValue }),
                resolveDestinationFile: href => {
                    if (!navigation?.catalog) return null;
                    const destination = resolveDestinationRefFromHref(navigation.catalog, href);
                    if (!destination || destination.kind !== 'sessionDetails'
                        || (destination.params.serverId && destination.params.serverId !== props.scope.serverId)
                        || (destination.params.accountId && destination.params.accountId !== props.scope.accountId)) return null;
                    const file = parseSessionPaneUrlState(destination.params)?.details;
                    if (file?.kind !== 'file' || !destination.params.id) return null;
                    const workspace = resolveWorkspaceTargetForSession({ serverId: props.scope.serverId, sessionId: destination.params.id });
                    return workspace ? { kind: 'repository-file', scope: props.scope, machineId: workspace.machineId,
                        path: resolveMachineAbsolutePath({ rootPath: workspace.rootPath, requestPath: file.path }) } : null;
                },
                // Lab ST2: say what releasing does to the message: it travels with it, nothing sends yet.
                preview: { glyph: 'add', verb: t('entityDragDrop.composer.mentionHere'), target: t('entityDragDrop.composer.target'), consequence: t('entityDragDrop.composer.consequence') },
                reason: describeComposerEntityDropReason,
            });
        },
        execute: async effect => {
            if (!isCurrent()) return { status: 'refused', reason: { code: 'scopeMismatch', message: describeComposerEntityDropReason('scopeMismatch') } };
            const result = await executor.execute(effect.actionId as ActionId, effect.input,
                { surface: 'ui', serverId: props.scope.serverId, expectedAccountId: props.scope.accountId });
            if (result.ok) {
                const output = result.result as Readonly<{ status?: string }>;
                if (output.status === 'applied') return { status: 'applied' };
                return { status: 'refused', reason: { code: output.status ?? 'composerUnavailable', message: describeComposerEntityDropReason(output.status ?? 'composerUnavailable') } };
            }
            return { status: 'refused', reason: { code: result.errorCode ?? 'composerUnavailable', message: describeComposerEntityDropReason(result.errorCode ?? 'composerUnavailable') } } satisfies EntityDropOutcomeV1;
        },
    });
    const snapshot = useEntityDropTargetState(runtime, props.id);
    // Files carried from the computer light the composer like an admitted in-app carry (lab D3).
    const externalFilesLit = props.externalFilesActive === true && props.editable && props.presented;
    return (snapshot?.phase === 'carrying' && snapshot.admission?.status === 'allowed') || externalFilesLit
        // The outline takes the composer's own corner, so it lies exactly on the panel.
        ? <TreeDropOutline visual={{ kind: 'outline', targetId: props.id }} testID="composer-entity-drop-outline" radius={theme.parts.composer.radius} weight="container"
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none' }} /> : null;
}
