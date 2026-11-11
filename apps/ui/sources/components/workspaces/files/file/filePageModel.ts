import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveVisibleAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import type { WorkspaceFileEditorHeaderModel } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorHeaderModel';
import { hasRenderedTextPreview } from '@/scm/utils/filePresentation';

/** The page body's internal view enum; the segment labels (`FilePageMode`) are a view over it. */
export type FileDisplayMode = 'file' | 'diff' | 'markdown';
export type FileDiffMode = 'included' | 'pending' | 'both';

export type FilePageMode = 'view' | 'preview' | 'source' | 'changes';
export type FilePageModeOption = Readonly<{ id: FilePageMode; displayMode: FileDisplayMode }>;

/** The code body and Info name the same text lines, without allocating another line array. */
export function countFileTextLines(text: string): number {
    if (text.length === 0) return 0;
    let lines = 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) lines += 1;
    }
    return text.endsWith('\n') ? lines - 1 : lines;
}

export function resolveFilePageAttribution(input: Readonly<{
    agentName: string | null;
    requesterActor: TranscriptAccountActor | null | undefined;
    viewerScope: ServerAccountScope | null;
    hasOtherNamedCollaborator: boolean;
}>) {
    const requester = input.agentName && input.hasOtherNamedCollaborator
        ? resolveVisibleAccountActorPresentation({ actor: input.requesterActor, viewerScope: input.viewerScope,
            hasOtherNamedCollaborator: input.hasOtherNamedCollaborator })
        : null;
    return { agentName: input.agentName, requesterName: requester?.name ?? null };
}

export function resolveFilePageHeaderModel(input: Readonly<{
    kind: string;
    hasRenderableDiff: boolean;
    deleted?: boolean;
    pluginViewerSelected?: boolean;
    hasText: boolean;
    writeSupported: boolean;
    partial?: boolean;
    editorAvailable?: boolean;
}>) {
    const preview = hasRenderedTextPreview(input.kind);
    const modes: FilePageModeOption[] = input.pluginViewerSelected ? []
        : input.deleted ? [{ id: 'changes', displayMode: 'diff' }]
        : preview ? [{ id: 'preview', displayMode: 'markdown' }, { id: 'source', displayMode: 'file' }]
        : [{ id: 'view', displayMode: 'file' }];
    if (!input.pluginViewerSelected && !input.deleted && input.hasRenderableDiff && !input.partial) {
        modes.push({ id: 'changes', displayMode: 'diff' });
    }
    const editUnavailableReason: 'partial' | 'binary' | 'unsupported' | 'unavailable' | null = input.partial ? 'partial'
        : !input.hasText ? 'binary'
        : !input.writeSupported || input.deleted ? 'unsupported'
        : input.editorAvailable === false ? 'unavailable' : null;
    // A PDF's viewer searches its own text layer (FV5f); other binary kinds have nothing to find.
    const findAvailable = (input.hasText || input.kind === 'pdf') && !input.pluginViewerSelected;
    return { modes, findAvailable, editUnavailableReason };
}

/**
 * Edit → Done while clean → Save once dirty (lab delta 7). Save is the one primary only while it can save and
 * nothing else on the page carries the save: while the Machine isn't answering or a save waits for approval the
 * notice line speaks and its own Save (when back) is the primary, so the header's steps down to quiet (ED2o, ED2o-back).
 * On a phone the editor's key row carries Save (ED1p): the page then offers no second Save.
 */
export type FilePageEditControl = Readonly<{
    kind: 'edit' | 'done' | 'save';
    onPress: () => void;
    primary?: boolean;
    busy?: boolean;
    disabled?: boolean;
}>;

export function resolveFilePageEditControl(input: Readonly<{
    fileEditorEnabled: boolean;
    isEditingFile: boolean;
    editor?: WorkspaceFileEditorHeaderModel;
    onStart?: () => void;
    onSave?: () => void;
    onCancel?: () => void;
    /** The checkout's Machine isn't answering (the notice line names it). */
    machineUnreachable?: boolean;
    /** The phone editor's key row is up and carries Save. */
    keyRowCarriesSave?: boolean;
}>): FilePageEditControl | null {
    if (!input.fileEditorEnabled) return null;
    if (!input.isEditingFile) return input.onStart ? { kind: 'edit', onPress: input.onStart } : null;
    const status = input.editor?.status ?? 'clean';
    // A standing conflict is resolved on its line (Compare · Use mine · Use {agent}'s); Save leaves the header.
    if (status === 'conflict') return null;
    if (status === 'clean') {
        const done = input.editor?.onDone ?? input.onCancel;
        return done ? { kind: 'done', onPress: done } : null;
    }
    if (input.keyRowCarriesSave) return null;
    const save = input.editor?.onSave ?? input.onSave;
    if (!save) return null;
    const refusal = input.editor?.refusal?.kind;
    const elsewhere = input.machineUnreachable === true || refusal === 'unreachable' || refusal === 'awaitingApproval';
    return { kind: 'save', onPress: save, busy: status === 'saving', primary: input.editor?.canSave !== false && !elsewhere };
}
