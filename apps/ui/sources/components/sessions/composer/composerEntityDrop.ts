import { ComposerOperationV1Schema, type ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { validatePluginDragSourceReferenceV1 } from '@happier-dev/protocol/plugins/contributions/entityDragDrop';
import { readComposerReferenceMentionV1 } from '@happier-dev/protocol/runtime/input/composerReferenceProviderV1';
import type { PluginContributionClientPlatform } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { EntityDragItemV1, EntityDragScopeV1, EntityDropAdmissionV1, EntityDropPreviewV1 } from '@happier-dev/protocol/plugins/ui';
import { entityDragScopesEqualV1 } from '@happier-dev/protocol/plugins/ui';
import { composerRefsV1Equal } from '@happier-dev/protocol/plugins/ui/composerRef';
import { listCurrentComposerReferences, type ComposerReferenceSearchHost } from '@/components/autocomplete/composerSuggestionKinds';
import type { ComposerSessionSuggestionItem } from '@/sync/domains/input/suggestionSession';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import { buildComposerFileReferenceSelection, buildComposerSessionReferenceSelection, buildContributedComposerReferenceSelection } from '@/sync/domains/input/composerReferenceSelection';
import { isAbsoluteLocalPath, normalizeLocalPathForComparison, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { normalizePluginUiProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiClientDragSourceRegistration, type PluginUiClientExecutableRegistrationReader } from '@/components/plugins/reactNative/clientExecutableContributions';
import type { ComposerPresentationAttachmentComposition } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export type ComposerEntityDropContext = Readonly<{
    scope: EntityDragScopeV1;
    ref: ComposerRefV1;
    snapshot: ComposerSnapshotV1 | null;
    sessions: readonly ComposerSessionSuggestionItem[];
    workspace: FileSuggestionScope | null;
    referenceHost?: ComposerReferenceSearchHost | null;
    attachmentComposition?: ComposerPresentationAttachmentComposition | null;
    platform?: PluginContributionClientPlatform;
    dragSourceReader?: PluginUiClientExecutableRegistrationReader;
    dragSources?: PluginUiProjectionModel['dragSourcesById'];
    resolveDestinationFile?: (href: string) => Extract<EntityDragItemV1, { kind: 'repository-file' }> | null;
    preview: EntityDropPreviewV1;
    reason: (code: string) => string;
}>;

export function resolveComposerEntityDrop(item: EntityDragItemV1, context: ComposerEntityDropContext): EntityDropAdmissionV1 {
    const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused',
        reason: { code, message: context.reason(code) }, preview: context.preview });
    if (!entityDragScopesEqualV1(item.scope, context.scope)) return refuse('scopeMismatch');
    const snapshot = context.snapshot;
    if (!snapshot || !composerRefsV1Equal(snapshot.ref, context.ref)) return refuse('composerUnavailable');
    if (!snapshot.state.editable || snapshot.state.inputLock?.mode === 'editAndSubmit') return refuse('notEditable');
    if (item.kind === 'plugin') {
        const host = context.referenceHost;
        if (!host || host.serverId !== context.scope.serverId || !host.isCurrent()) return refuse('referenceUnavailable');
        const platform = context.platform ?? resolvePluginUiClientExecutablePlatform();
        const sources = context.dragSources ?? normalizePluginUiProjection(host.projection, platform).dragSourcesById;
        const source = sources[buildQualifiedPluginContributionKey(item.contribution)];
        const localId = source?.definition.composerAttachment;
        if (source && localId) {
            if (!snapshot.capabilities.attachments) return refuse('referenceUnavailable');
            const identity = { pluginId: source.pluginId, localId };
            const attachment = context.attachmentComposition?.composerAttachmentsById[buildQualifiedPluginContributionKey(identity)];
            const registrationInput = { source, platform, reader: context.dragSourceReader };
            const registration = resolvePluginUiClientDragSourceRegistration(registrationInput);
            if (!attachment || attachment.occurrenceId !== source.occurrenceId || attachment.identity.pluginId !== identity.pluginId
                || attachment.identity.localId !== identity.localId || !registration?.runtime.toComposerAttachment) return refuse('referenceUnavailable');
            try {
                if (!validatePluginDragSourceReferenceV1(source.definition, item.reference)) return refuse('referenceUnavailable');
                const value = registration.runtime.toComposerAttachment(item.reference);
                const operation = ComposerOperationV1Schema.safeParse({ kind: 'attachment.add', attachmentLocalId: localId, value });
                if (!operation.success || operation.data.kind !== 'attachment.add' || !attachment.valueValidator?.(operation.data.value.value)
                    || !host.isCurrent() || resolvePluginUiClientDragSourceRegistration(registrationInput)?.registration !== registration.registration) return refuse('referenceUnavailable');
                return { status: 'allowed', effect: { actionId: 'composer.transaction.apply', input: {
                    scope: context.scope, ref: context.ref, attachmentContributor: identity,
                    transaction: { expectedRevision: snapshot.revision, operations: [operation.data] },
                }, preview: context.preview } };
            } catch { return refuse('referenceUnavailable'); }
        }
    }
    if (!snapshot.capabilities.references) return refuse('referenceUnavailable');
    if (item.kind === 'destination') {
        const file = context.resolveDestinationFile?.(item.href);
        return file ? resolveComposerEntityDrop(file, context) : refuse('referenceUnavailable');
    }

    let selection: ReturnType<typeof buildComposerFileReferenceSelection> | ReturnType<typeof buildComposerSessionReferenceSelection> | ReturnType<typeof buildContributedComposerReferenceSelection>;
    if (item.kind === 'session') {
        if (item.address.serverId !== context.scope.serverId) return refuse('scopeMismatch');
        const candidate = context.sessions.find(candidate => candidate.id === item.address.sessionId && candidate.serverId === item.address.serverId);
        if (!candidate) return refuse('referenceUnavailable');
        selection = buildComposerSessionReferenceSelection(candidate);
    } else if (item.kind === 'repository-file') {
        const workspace = context.workspace;
        if (!workspace || workspace.serverId !== item.scope.serverId || workspace.machineId !== item.machineId) return refuse('workspaceMismatch');
        // File references are relative to the composing workspace. Qualified source rows
        // supply absolute paths, so another repository on the same machine cannot alias.
        const path = normalizeLocalPathForComparison(item.path);
        if (!path || !isAbsoluteLocalPath(path) || path.split('/').some(part => part === '..')) return refuse('workspaceMismatch');
        const relative = resolvePathRelativeToRoot({ path: item.path, root: workspace.rootPath });
        if (!relative || relative === '.') return refuse('workspaceMismatch');
        selection = buildComposerFileReferenceSelection(relative, relative.split('/').at(-1) ?? relative);
    } else if (item.kind === 'plugin') {
        const host = context.referenceHost;
        if (!host || host.serverId !== context.scope.serverId || !host.isCurrent()) return refuse('referenceUnavailable');
        // The source's schema admits its reference. Only the incumbent MentionRef
        // provider identity is interpreted here; arbitrary data and carried Actions refuse.
        if (item.reference === null || typeof item.reference !== 'object' || Array.isArray(item.reference)) return refuse('referenceUnavailable');
        const reference = readComposerReferenceMentionV1({ ...item.reference, token: '@' });
        if (!reference || reference.reference.pluginId !== item.contribution.pluginId) return refuse('referenceUnavailable');
        const current = listCurrentComposerReferences(host.projection).find(current => (
            current.reference.pluginId === reference.reference.pluginId && current.reference.localId === reference.reference.localId
        ));
        const trigger = current?.presentation.kind === 'composerReference' ? current.presentation.triggers[0] : undefined;
        if (!trigger || !reference.label) return refuse('referenceUnavailable');
        selection = buildContributedComposerReferenceSelection({ reference: reference.reference,
            candidate: { id: reference.candidateId, label: reference.label }, trigger });
    } else return refuse('referenceUnavailable');

    const spacer = snapshot.text.length > 0 && !/\s$/.test(snapshot.text) ? ' ' : '';
    const start = snapshot.text.length + spacer.length;
    return { status: 'allowed', effect: { actionId: 'composer.transaction.apply', input: {
        scope: context.scope, ref: context.ref, transaction: { expectedRevision: snapshot.revision, operations: [
            { kind: 'text.insert', position: { offset: snapshot.text.length }, text: spacer + selection.token },
            { kind: 'reference.insert', reference: { ...selection.payload, token: selection.token, start, end: start + selection.token.length } },
        ] },
    }, preview: context.preview } };
}
