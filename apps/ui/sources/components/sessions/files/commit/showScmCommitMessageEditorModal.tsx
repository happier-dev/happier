import * as React from 'react';

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

        type WrapperProps = Readonly<{
            onRequestClose?: () => void;
            onClose: () => void;
        }>;

        const Wrapper: React.FC<WrapperProps> = ({ onClose }) => (
            <ScmCommitMessageEditorModal
                title={params.title}
                initialMessage={params.initialMessage ?? ''}
                canGenerate={params.canGenerate}
                onGenerate={params.onGenerate}
                onResolve={onResolve}
                onClose={onClose}
            />
        );

        Modal.show({
            component: Wrapper,
            props: {
                // Called when the modal is dismissed via backdrop/escape. Treat it as cancel.
                onRequestClose: () => onResolve({ kind: 'cancel' }),
            },
            closeOnBackdrop: true,
        });
    });
}
