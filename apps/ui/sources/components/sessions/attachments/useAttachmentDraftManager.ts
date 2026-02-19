import * as React from 'react';

import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { PickedAttachment, AttachmentFilePickerHandle } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import type { AgentInputAttachment } from '@/components/sessions/agentInput/AgentInput';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import type { AttachmentDraft } from './attachmentDraftModel';

function resolveSourceSizeBytes(source: AttachmentsUploadFileSource): number | null {
    if (source.kind === 'web') return source.file.size;
    return typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : null;
}

export function useAttachmentDraftManager(params: Readonly<{
    enabled: boolean;
    maxFileBytes: number;
}>): Readonly<{
    filePickerRef: React.RefObject<AttachmentFilePickerHandle | null>;
    drafts: readonly AttachmentDraft[];
    hasSendableAttachments: boolean;
    agentInputAttachments: readonly AgentInputAttachment[];
    addWebFiles: (files: readonly File[]) => void;
    addPickedAttachments: (picked: readonly PickedAttachment[]) => void;
    removeDraft: (id: string) => void;
    clearDrafts: () => void;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>) => void;
}> {
    const filePickerRef = React.useRef<AttachmentFilePickerHandle | null>(null);
    const [drafts, setDrafts] = React.useState<AttachmentDraft[]>([]);

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
            Modal.alert('File too large', `Skipped ${skippedOversizeCount} file(s) that exceed the max attachment size.`);
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

    const agentInputAttachments = React.useMemo<readonly AgentInputAttachment[]>(() => {
        return drafts.map((d) => ({
            key: d.id,
            label: d.source.kind === 'web' ? d.source.file.name : d.source.name,
            status: d.status,
            onRemove: d.status === 'uploading' ? undefined : () => removeDraft(d.id),
        }));
    }, [drafts, removeDraft]);

    return {
        filePickerRef,
        drafts,
        hasSendableAttachments: drafts.length > 0,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        removeDraft,
        clearDrafts,
        applyDraftPatch,
    };
}
