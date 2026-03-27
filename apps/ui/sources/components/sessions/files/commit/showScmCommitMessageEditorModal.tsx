import { Modal } from '@/modal';

import { ScmCommitMessageEditorModal, type ScmCommitMessageGenerateResult } from './ScmCommitMessageEditorModal';

export async function showScmCommitMessageEditorModal(params: Readonly<{
    title: string;
    initialMessage?: string;
    canGenerate: boolean;
    onGenerate: () => Promise<ScmCommitMessageGenerateResult>;
}>): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
        const onResolve = (value: { kind: 'cancel' } | { kind: 'commit'; message: string }) => {
            resolve(value.kind === 'commit' ? value.message : null);
        };

        Modal.show({
            component: ScmCommitMessageEditorModal,
            props: {
                title: params.title,
                initialMessage: params.initialMessage ?? '',
                canGenerate: params.canGenerate,
                onGenerate: params.onGenerate,
                onResolve,
            },
            onRequestClose: () => onResolve({ kind: 'cancel' }),
            closeOnBackdrop: true,
        });
    });
}
