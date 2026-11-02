import { admitAttachmentDraftSources, startEagerAttachmentDraftUploads } from './attachmentDraftAdmission';
import { projectAttachmentDraftToAgentInputAttachment, resolveAttachmentImagePresentation } from './attachmentDraftPresentation';
import * as React from 'react';

import type { AttachmentUploadSource, AddWebAttachmentsOptions } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { PickedAttachment, AttachmentFilePickerHandle } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import type { AgentInputAttachment } from '@/components/sessions/agentInput/agentInputContracts';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { nativeReadClipboardImageAttachment } from '@/utils/files/nativeClipboardImageAttachment';
import { removeSubmittedAttachmentDrafts, sendableAttachmentDrafts, type AttachmentDraft } from './attachmentDraftModel';
import { getAttachmentDraftsSnapshotForKey, patchAttachmentDraftForKey, settleAttachmentDraftsForKey,
    subscribeAttachmentDraftsForKey, writeAttachmentDraftsForKey } from './attachmentDraftMemoryStore';
import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

export function useAttachmentDraftManager(params: Readonly<{
    enabled: boolean;
    maxFileBytes: number;
    initialDrafts?: readonly AttachmentDraft[];
    /** Existing Account/draft/occurrence address; this manager binds the shared memory owner. */
    memoryKey?: string | null;
    isCurrent?: () => boolean;
    eagerUpload?: Readonly<{ sessionId: string; sessionTarget?: ExactSessionMachineTargetIdentity;
        config: AttachmentsUploadConfig; transferContext?: SessionAttachmentTransferContext }>;
    /** Picked uploads mention the exact drafts admitted by this intake owner. */
    onPickedDrafts?: (drafts: readonly AttachmentDraft[]) => void;
    /** The mounted document owner removes exact chip occurrences in the same user action. */
    onRemoveDraft?: (id: string) => void;
}>): Readonly<{
    filePickerRef: React.RefObject<AttachmentFilePickerHandle | null>;
    drafts: readonly AttachmentDraft[];
    getDraftsSnapshot: () => readonly AttachmentDraft[];
    getSendableDraftsSnapshot: () => readonly AttachmentDraft[];
    /** Process-local mutation revision for compare-and-restore consumers. */
    getDraftRevisionSnapshot: () => number;
    hasSendableAttachments: boolean;
    agentInputAttachments: readonly AgentInputAttachment[];
    addWebFiles: (files: readonly File[], options?: AddWebAttachmentsOptions) => readonly AttachmentDraft[];
    addPickedAttachments: (picked: readonly PickedAttachment[]) => void;
    /** Native "Paste image": the clipboard picture joins the tray as a picked attachment. */
    pasteClipboardImage: () => void;
    removeDraft: (id: string) => void;
    removeSubmittedDrafts: (submitted: readonly AttachmentDraft[]) => readonly AttachmentDraft[];
    clearDrafts: () => void;
    replaceDrafts: (drafts: readonly AttachmentDraft[]) => void;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>, expectedSource?: AttachmentUploadSource) => void;
}> {
    const filePickerRef = React.useRef<AttachmentFilePickerHandle | null>(null);
    const memoryKey = params.memoryKey ?? null;
    const activeMemoryKey = React.useRef(memoryKey);
    const mounted = React.useRef(true);
    const currentAdmission = React.useRef(params.isCurrent);
    currentAdmission.current = params.isCurrent;
    const [drafts, setDrafts] = React.useState<AttachmentDraft[]>(() => [...(params.initialDrafts
        ?? (memoryKey ? getAttachmentDraftsSnapshotForKey(memoryKey) : []))]);
    const draftsRef = React.useRef<AttachmentDraft[]>(drafts);
    const draftRevisionRef = React.useRef(0);
    const onRemoveDraftRef = React.useRef(params.onRemoveDraft);
    onRemoveDraftRef.current = params.onRemoveDraft;
    const onPickedDraftsRef = React.useRef(params.onPickedDrafts);
    onPickedDraftsRef.current = params.onPickedDrafts;
    const eagerUploadRef = React.useRef(params.eagerUpload);
    eagerUploadRef.current = params.eagerUpload;
    const eagerUploadsRef = React.useRef(new Map<string, AbortController>());

    const webPreviewUrlsRef = React.useRef(new Map<string, Readonly<{ file: File; url: string }>>());
    const [webPreviewUrlsVersion, setWebPreviewUrlsVersion] = React.useState(0);

    const getDraftsSnapshot = React.useCallback(() => activeMemoryKey.current !== memoryKey || !mounted.current
        ? memoryKey ? getAttachmentDraftsSnapshotForKey(memoryKey) : [] : draftsRef.current, [memoryKey]);
    const getSendableDraftsSnapshot = React.useCallback(() => sendableAttachmentDrafts(getDraftsSnapshot()), [getDraftsSnapshot]);
    const getDraftRevisionSnapshot = React.useCallback(() => draftRevisionRef.current, []);

    const commitDrafts = React.useCallback((updater: (previous: AttachmentDraft[]) => AttachmentDraft[]) => {
        if (!mounted.current || activeMemoryKey.current !== memoryKey) return;
        // Keep this side effect outside React's updater: Strict Mode may replay
        // updater functions, but one public mutation call gets exactly one
        // currentness revision.
        draftRevisionRef.current += 1;
        // This manager is the process-local draft owner. Advance its snapshot
        // synchronously so an immediate Send observes the attachment even
        // before React commits the visual row. Using the ref as the input also
        // preserves multiple same-turn mutations without updater replay side
        // effects in Strict Mode.
        const next = updater(draftsRef.current);
        draftsRef.current = next;
        if (memoryKey) writeAttachmentDraftsForKey(memoryKey, next);
        setDrafts(next);
    }, [memoryKey]);

    React.useLayoutEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    React.useEffect(() => {
        return () => {
            const map = webPreviewUrlsRef.current;
            const urlApi = globalThis.URL;
            for (const preview of map.values()) {
                try { urlApi?.revokeObjectURL?.(preview.url); } catch { }
            }
            map.clear();
        };
    }, []);

    const applyDraftPatch = React.useCallback((id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>, expectedSource?: AttachmentUploadSource) => {
        if (memoryKey) { patchAttachmentDraftForKey(memoryKey, id, patch, expectedSource); return; }
        if (expectedSource && !draftsRef.current.some((draft) => draft.id === id && draft.source === expectedSource)) return;
        commitDrafts((prev) => prev.map((d) => d.id === id ? ({ ...d, ...patch } as AttachmentDraft) : d));
    }, [commitDrafts, memoryKey]);

    const startEagerUploads = React.useCallback((added: readonly AttachmentDraft[]) => {
        startEagerAttachmentDraftUploads({ drafts: added, target: eagerUploadRef.current,
            activeUploads: eagerUploadsRef.current, applyDraftPatch });
    }, [applyDraftPatch]);

    React.useEffect(() => () => {
        for (const controller of eagerUploadsRef.current.values()) controller.abort();
        eagerUploadsRef.current.clear();
    }, [params.eagerUpload?.sessionId, params.eagerUpload?.sessionTarget?.serverId, params.eagerUpload?.sessionTarget?.accountId]);

    const addSources = React.useCallback((sources: readonly AttachmentUploadSource[]): readonly AttachmentDraft[] => {
        if (!params.enabled || !mounted.current || activeMemoryKey.current !== memoryKey || currentAdmission.current?.() === false) return [];

        const { drafts: next, skippedOversizeCount } = admitAttachmentDraftSources({ sources, maxFileBytes: params.maxFileBytes });

        if (skippedOversizeCount > 0) {
            Modal.alert(
                t('attachments.alerts.fileTooLargeTitle'),
                t('attachments.alerts.fileTooLargeBody', { count: skippedOversizeCount }),
            );
        }
        if (next.length === 0) return [];
        commitDrafts((prev) => [...prev, ...next]);
        startEagerUploads(next);
        return next;
    }, [commitDrafts, memoryKey, params.enabled, params.maxFileBytes, startEagerUploads]);

    const addWebFiles = React.useCallback((files: readonly File[], options?: AddWebAttachmentsOptions) => {
        return addSources(options?.sources ?? files.map((file) => ({ kind: 'web' as const, file })));
    }, [addSources]);

    const addPickedAttachments = React.useCallback((picked: readonly PickedAttachment[]) => {
        const added = addSources(picked);
        if (added.length > 0) onPickedDraftsRef.current?.(added);
    }, [addSources]);

    const pasteClipboardImage = React.useCallback(() => {
        const unavailable = () => Modal.alert(t('attachments.alerts.noClipboardImageTitle'), t('attachments.alerts.noClipboardImageBody'));
        fireAndForget((async () => {
            const picked = await nativeReadClipboardImageAttachment();
            if (picked.length === 0) { unavailable(); return; }
            addPickedAttachments(picked);
        })(), { onError: unavailable });
    }, [addPickedAttachments]);

    const removeDraft = React.useCallback((id: string) => {
        if (!mounted.current || activeMemoryKey.current !== memoryKey) return;
        eagerUploadsRef.current.get(id)?.abort();
        onRemoveDraftRef.current?.(id);
        commitDrafts((prev) => prev.filter((d) => d.id !== id));
    }, [commitDrafts, memoryKey]);

    const removeSubmittedDrafts = React.useCallback((submitted: readonly AttachmentDraft[]) => {
        // Source objects are immutable through manager patches; upload checkpoints
        // retain their identity, while a replacement source must survive acceptance.
        if (memoryKey) return settleAttachmentDraftsForKey(memoryKey, submitted);
        const current = draftsRef.current;
        const remaining = removeSubmittedAttachmentDrafts(current, submitted);
        if (remaining.length !== current.length) commitDrafts(() => [...remaining]);
        return draftsRef.current;
    }, [commitDrafts, memoryKey]);

    const clearDrafts = React.useCallback(() => {
        commitDrafts(() => []);
    }, [commitDrafts]);

    const replaceDrafts = React.useCallback((nextDrafts: readonly AttachmentDraft[]) => {
        commitDrafts(() => [...nextDrafts]);
    }, [commitDrafts]);

    React.useLayoutEffect(() => {
        const changed = activeMemoryKey.current !== memoryKey;
        activeMemoryKey.current = memoryKey;
        if (changed) replaceDrafts(memoryKey ? getAttachmentDraftsSnapshotForKey(memoryKey) : []);
        else if (memoryKey) writeAttachmentDraftsForKey(memoryKey, draftsRef.current);
        if (!memoryKey) return;
        const follow = () => {
            if (!mounted.current || activeMemoryKey.current !== memoryKey) return;
            const next = getAttachmentDraftsSnapshotForKey(memoryKey);
            if (next.length === draftsRef.current.length && next.every((draft, index) => draft === draftsRef.current[index])) return;
            replaceDrafts(next);
        };
        const unsubscribe = subscribeAttachmentDraftsForKey(memoryKey, follow);
        follow();
        return unsubscribe;
    }, [memoryKey, replaceDrafts]);

    React.useEffect(() => {
        const map = webPreviewUrlsRef.current;
        const urlApi = globalThis.URL;
        let changed = false;

        const activeFiles = new Map(drafts.flatMap(draft => draft.source.kind === 'web' && resolveAttachmentImagePresentation(draft.source)
            ? [[draft.id, draft.source.file] as const] : []));
        for (const [id, preview] of map) {
            // A draft can replace its source without changing identity. Only
            // the current File owns a preview, including across upload patches.
            if (activeFiles.get(id) === preview.file) continue;
            try { urlApi?.revokeObjectURL?.(preview.url); } catch { }
            map.delete(id);
            changed = true;
        }

        for (const [id, file] of activeFiles) {
            if (map.has(id)) continue;
            if (typeof urlApi?.createObjectURL !== 'function') continue;
            try {
                const url = urlApi.createObjectURL(file);
                map.set(id, { file, url });
                changed = true;
            } catch {
                // ignore
            }
        }

        if (changed) {
            setWebPreviewUrlsVersion((v) => v + 1);
        }
    }, [drafts]);
    const agentInputAttachments = React.useMemo<readonly AgentInputAttachment[]>(() => {
        void webPreviewUrlsVersion;
        const webUrls = webPreviewUrlsRef.current;
        return drafts.map(draft => projectAttachmentDraftToAgentInputAttachment(draft, {
            webPreviewUri: webUrls.get(draft.id)?.url,
            onRemove: () => removeDraft(draft.id),
        }));
    }, [drafts, removeDraft, webPreviewUrlsVersion]);

    // Referential stability contract: memoized consumers (composer, transcript rows) receive
    // this manager or its callbacks as props; a fresh object per render would re-render them
    // on every parent commit.
    return React.useMemo(() => ({
        filePickerRef,
        drafts,
        getDraftsSnapshot,
        getSendableDraftsSnapshot,
        getDraftRevisionSnapshot,
        hasSendableAttachments: sendableAttachmentDrafts(drafts).length > 0,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        pasteClipboardImage,
        removeDraft,
        removeSubmittedDrafts,
        clearDrafts,
        replaceDrafts,
        applyDraftPatch,
    }), [
        addPickedAttachments,
        pasteClipboardImage,
        addWebFiles,
        agentInputAttachments,
        applyDraftPatch,
        clearDrafts,
        drafts,
        getDraftRevisionSnapshot,
        getDraftsSnapshot,
        getSendableDraftsSnapshot,
        removeDraft,
        removeSubmittedDrafts,
        replaceDrafts,
    ]);
}
