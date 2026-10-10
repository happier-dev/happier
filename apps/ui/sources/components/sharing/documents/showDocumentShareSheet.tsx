import * as React from 'react';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { classifyArtifactBrowserKind } from '@/components/artifacts/artifactBrowserModel';
import { artifactKindLabel } from '@/components/artifacts/artifactKindPresentation';
import { useWorkBoard } from '@/components/boards/model/useWorkBoards';
import { useBoardLiveSummary } from '@/components/boards/model/useBoardContent';
import type { WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { DocumentShareSheet, type DocumentShareSheetProps } from './DocumentShareSheet';

type DocumentShareModalProps = CustomModalInjectedProps & Omit<DocumentShareSheetProps, 'onRequestClose' | 'presentation'>;

function DocumentShareModal(props: DocumentShareModalProps): React.ReactElement {
    const { onClose, setChrome: _setChrome, ...sheet } = props;
    return <DocumentShareSheet {...sheet} presentation="full" onRequestClose={onClose} />;
}

function LoadedBoardShareIdentity(props: Readonly<{ board: WorkBoardV1; kindLabel: string }>): React.ReactElement {
    const summary = useBoardLiveSummary(props.board);
    return <>{props.kindLabel} · {t('boards.meta.items', { count: summary.itemCount })}</>;
}

/** The open sheet mounts the existing Board membership/count owner, not a saved preview count. */
function BoardShareIdentity(props: Readonly<{ artifactId: string; kindLabel: string }>): React.ReactElement {
    const board = useWorkBoard(props.artifactId);
    return board ? <LoadedBoardShareIdentity board={board} kindLabel={props.kindLabel} /> : <>{props.kindLabel}</>;
}

/**
 * The one share action for documents: a host's existing share slot (a workflow, role or launch
 * profile) calls this with the document and its name; the sheet does the rest.
 */
export function showDocumentShareSheet(params: Omit<DocumentShareSheetProps, 'onRequestClose' | 'presentation'> & Readonly<{
    name: string;
    /** Context only, for example "6 steps". The sheet owns the localized kind prefix. */
    subtitle?: string;
}>): void {
    const { name, subtitle, ...sheet } = params;
    const kind = classifyArtifactBrowserKind({ id: sheet.artifactId, header: { kind: sheet.kind } }) ?? 'document';
    const kindLabel = artifactKindLabel(kind);
    const identity = kind === 'board' ? <BoardShareIdentity artifactId={sheet.artifactId} kindLabel={kindLabel} />
        : [kindLabel, subtitle?.trim()].filter(Boolean).join(' · ');
    Modal.show({
        component: DocumentShareModal,
        props: sheet,
        chrome: {
            kind: 'card',
            phonePresentation: 'sheet',
            testID: 'document-share-modal',
            title: t('shareSheet.documents.shareTitle', { name }),
            subtitle: identity,
            // Content-sized card chrome; the sheet's SelectionList owns its rows, not a body ScrollView.
            scrollHost: 'overlay',
            bodyScroll: 'none',
            dimensions: { width: 560, maxHeightRatio: 0.92, size: 'md' },
        },
        closeOnBackdrop: true,
    });
}
