import * as React from 'react';

import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { PickedAttachment, AttachmentFilePickerHandle } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import type { AgentInputAttachment } from '@/components/sessions/agentInput/agentInputContracts';
import { Modal } from '@/modal';
import { t } from '@/text';
import { randomUUID } from '@/platform/randomUUID';
import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import type { AttachmentDraft } from './attachmentDraftModel';

function resolveSourceSizeBytes(source: AttachmentsUploadFileSource): number | null {
    if (source.kind === 'web') return source.file.size;
    if (source.kind === 'memory') return source.bytes.byteLength;
    return typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : null;
}

function resolveSourceName(source: AttachmentsUploadFileSource): string {
    if (source.kind === 'web') return source.file.name;
    return source.name;
}

function isImageSource(source: AttachmentsUploadFileSource): boolean {
    if (source.kind === 'web') {
        if (source.file.type && source.file.type.startsWith('image/')) return true;
        return Boolean(getImageMimeTypeFromPath(source.file.name));
    }
    if (source.mimeType && String(source.mimeType).startsWith('image/')) return true;
    return Boolean(getImageMimeTypeFromPath(source.name));
}

export function useAttachmentDraftManager(params: Readonly<{
    enabled: boolean;
    maxFileBytes: number;
    initialDrafts?: readonly AttachmentDraft[];
}>): Readonly<{
    filePickerRef: React.RefObject<AttachmentFilePickerHandle | null>;
    drafts: readonly AttachmentDraft[];
    getDraftsSnapshot: () => readonly AttachmentDraft[];
    hasSendableAttachments: boolean;
    agentInputAttachments: readonly AgentInputAttachment[];
    addWebFiles: (files: readonly File[]) => void;
    addPickedAttachments: (picked: readonly PickedAttachment[]) => void;
    removeDraft: (id: string) => void;
    clearDrafts: () => void;
    replaceDrafts: (drafts: readonly AttachmentDraft[]) => void;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>) => void;
}> {
    const filePickerRef = React.useRef<AttachmentFilePickerHandle | null>(null);
    const [drafts, setDrafts] = React.useState<AttachmentDraft[]>(() => [...(params.initialDrafts ?? [])]);
    const draftsRef = React.useRef<AttachmentDraft[]>(params.initialDrafts ? [...params.initialDrafts] : []);

    const webPreviewUrlsRef = React.useRef<Map<string, string>>(new Map());
    const [webPreviewUrlsVersion, setWebPreviewUrlsVersion] = React.useState(0);

    React.useEffect(() => {
        draftsRef.current = drafts;
    }, [drafts]);

    const getDraftsSnapshot = React.useCallback(() => draftsRef.current, []);

    React.useEffect(() => {
        return () => {
            const map = webPreviewUrlsRef.current;
            const urlApi = globalThis.URL;
            for (const url of map.values()) {
                try { urlApi?.revokeObjectURL?.(url); } catch { }
            }
            map.clear();
        };
    }, []);

    const applyDraftPatch = React.useCallback((id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>) => {
        setDrafts((prev) => prev.map((d) => d.id === id ? ({ ...d, ...patch } as AttachmentDraft) : d));
    }, []);

    const addSources = React.useCallback((sources: readonly AttachmentsUploadFileSource[]) => {
        if (!params.enabled) return;

        const next: AttachmentDraft[] = [];
        let skippedOversizeCount = 0;
        for (const source of sources) {
            const sizeBytes = resolveSourceSizeBytes(source);
            if (sizeBytes != null && sizeBytes > params.maxFileBytes) {
                skippedOversizeCount += 1;
                continue;
            }
            next.push({
                id: randomUUID(),
                source,
                status: 'pending',
            });
        }

        if (skippedOversizeCount > 0) {
            Modal.alert(
                t('attachments.alerts.fileTooLargeTitle'),
                t('attachments.alerts.fileTooLargeBody', { count: skippedOversizeCount }),
            );
        }
        if (next.length === 0) return;
        setDrafts((prev) => [...prev, ...next]);
    }, [params.enabled, params.maxFileBytes]);

    const addWebFiles = React.useCallback((files: readonly File[]) => {
        addSources(files.map((file) => ({ kind: 'web' as const, file })));
    }, [addSources]);

    const addPickedAttachments = React.useCallback((picked: readonly PickedAttachment[]) => {
        addSources(picked);
    }, [addSources]);

    const removeDraft = React.useCallback((id: string) => {
        setDrafts((prev) => prev.filter((d) => d.id !== id));
    }, []);

    const clearDrafts = React.useCallback(() => {
        setDrafts([]);
    }, []);

    const replaceDrafts = React.useCallback((nextDrafts: readonly AttachmentDraft[]) => {
        setDrafts([...nextDrafts]);
    }, []);

    React.useEffect(() => {
        const map = webPreviewUrlsRef.current;
        const urlApi = globalThis.URL;
        let changed = false;

        const activeIds = new Set(drafts.map((d) => d.id));
        for (const [id, url] of map) {
            if (activeIds.has(id)) continue;
            try { urlApi?.revokeObjectURL?.(url); } catch { }
            map.delete(id);
            changed = true;
        }

        for (const draft of drafts) {
            if (draft.source.kind !== 'web') continue;
            if (!isImageSource(draft.source)) continue;
            if (map.has(draft.id)) continue;
            if (typeof urlApi?.createObjectURL !== 'function') continue;
            try {
                const url = urlApi.createObjectURL(draft.source.file);
                map.set(draft.id, url);
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

        return drafts.map((d) => {
            const name = resolveSourceName(d.source);
            const imagePreviewUri = isImageSource(d.source)
                ? (
                    d.source.kind === 'native'
                        ? d.source.uri
                        : d.source.kind === 'memory'
                            ? d.source.previewUri ?? null
                            : (webUrls.get(d.id) ?? null)
                )
                : null;

            return {
                key: d.id,
                label: name,
                status: d.status,
                preview: imagePreviewUri ? { kind: 'image', uri: imagePreviewUri } : undefined,
                uploadProgress: d.uploadProgress,
                error: d.error,
                onRemove: () => removeDraft(d.id),
            };
        });
    }, [drafts, removeDraft, webPreviewUrlsVersion]);

    return {
        filePickerRef,
        drafts,
        getDraftsSnapshot,
        hasSendableAttachments: drafts.length > 0,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        removeDraft,
        clearDrafts,
        replaceDrafts,
        applyDraftPatch,
    };
}
