import * as React from 'react';
import type { ComposerRefV1, ActionId } from '@happier-dev/protocol';
import type { EntityDragKindV1, EntityDragScopeV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { useEntityDragDropRuntime, useEntityDropTarget, useEntityDropTargetState, TreeDropOutline,
    type WindowBounds } from '@/components/ui/treeDragDrop';
import { readMountedComposerPresentationSnapshot, readMountedComposerAttachmentComposition } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readComposerSessionSuggestionItems } from '@/sync/domains/input/suggestionSession';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import type { ComposerReferenceSearchHost } from '@/components/autocomplete/composerSuggestionKinds';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';
import { resolveComposerEntityDrop } from './composerEntityDrop';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { resolveDestinationRefFromHref } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export function describeComposerEntityDropReason(code: string): string {
    if (code === 'scopeMismatch') return t('entityDragDrop.surface.scopeMismatch');
    if (code === 'notEditable') return t('entityDragDrop.composer.readOnly');
    if (code === 'workspaceMismatch') return t('entityDragDrop.composer.otherWorkspace');
    return t('entityDragDrop.composer.unavailable');
}

/** Only this feedback leaf observes carry changes; typing and pointer frames stay separate. */
export function ComposerEntityDropTarget(props: Readonly<{
    id: string;
    scope: EntityDragScopeV1;
    refValue: ComposerRefV1;
    bounds: () => WindowBounds | null;
    presented: boolean;
    editable: boolean;
    fileScope?: FileSuggestionScope | null;
    referenceHost?: ComposerReferenceSearchHost | null;
    kinds: readonly import('@/components/autocomplete/composerSuggestionKinds').ComposerSuggestionKindId[];
}>): React.ReactElement | null {
    const runtime = useEntityDragDropRuntime();
    const navigation = useOptionalWorkspaceNavigation();
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);
    const platform = resolvePluginUiClientExecutablePlatform();
    const projection = props.referenceHost?.projection ?? null;
    // Carry frames reuse the canonical normalized map; they do not normalize
    // every plugin family or recompile attachment schemas while hovering.
    const dragSources = React.useMemo(() => normalizePluginUiProjection(projection, platform).dragSourcesById, [projection, platform]);
    const acceptedKinds: EntityDragKindV1[] = [];
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
        id: props.id, scope: props.scope, acceptedKinds, getBounds: props.bounds, isCurrent,
        listDestinations: () => [{ destination: null, label: t('entityDragDrop.composer.addContext') }],
        resolve: ({ item }) => {
            const sessionId = props.refValue.kind === 'session' ? props.refValue.sessionId : null;
            return resolveComposerEntityDrop(item, {
                scope: props.scope, ref: props.refValue,
                snapshot: (() => {
                    const snapshot = readMountedComposerPresentationSnapshot({ scope: props.scope, ref: props.refValue });
                    return snapshot && !props.editable ? { ...snapshot, state: { ...snapshot.state, editable: false } } : snapshot;
                })(),
                sessions: item.kind === 'session' ? readComposerSessionSuggestionItems({
                    serverId: props.scope.serverId, currentSessionId: sessionId, candidateSessionId: item.address.sessionId,
                }) : [],
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
                preview: { verb: t('entityDragDrop.composer.addContext'), target: t('entityDragDrop.composer.target') },
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
    return snapshot?.phase === 'carrying' && snapshot.admission?.status === 'allowed'
        ? <TreeDropOutline visual={{ kind: 'outline', targetId: props.id }} testID="composer-entity-drop-outline"
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none' }} /> : null;
}
