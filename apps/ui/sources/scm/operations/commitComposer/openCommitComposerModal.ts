import { Modal } from '@/modal';

import type { CommitComposerDraft } from './commitComposerTypes';
import { CommitComposerModal } from './CommitComposerModal';

export async function openCommitComposerModal(params: Readonly<{
    initialTitle?: string;
    initialBody?: string;
    showGenerator: boolean;
    onGenerate?: () => Promise<CommitComposerDraft>;
}>): Promise<CommitComposerDraft | null> {
    let resolved = false;

    return await new Promise<CommitComposerDraft | null>((resolve) => {
        const safeResolve = (value: CommitComposerDraft | null) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
        };

        Modal.show({
            component: CommitComposerModal,
            props: {
                initialTitle: params.initialTitle ?? '',
                initialBody: params.initialBody ?? '',
                showGenerator: params.showGenerator,
                onGenerate: params.onGenerate,
                onSubmit: (draft: CommitComposerDraft) => safeResolve(draft),
                onCancel: () => safeResolve(null),
                onRequestClose: () => safeResolve(null),
            },
        });
    });
}
