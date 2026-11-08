import * as React from 'react';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { classifyArtifactBrowserKind } from '@/components/artifacts/artifactBrowserModel';
import { artifactKindLabel } from '@/components/artifacts/artifactKindPresentation';
import { useWorkBoard } from '@/components/boards/model/useWorkBoards';
import { describeBoardItemCount } from '@/components/boards/model/boardCards';
import { useBoardLiveSummary } from '@/components/boards/model/useBoardContent';
import type { WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { presentShareSheet, type ShareSheetAnchor } from '../presentShareSheet';
import { DocumentShareSheet, type DocumentShareSheetProps } from './DocumentShareSheet';
import { DocumentSignedInLinkSection } from './DocumentSignedInLinkSection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type DocumentShareModalProps = CustomModalInjectedProps & Omit<DocumentShareSheetProps, 'onRequestClose' | 'presentation'>;

function DocumentShareModal(props: DocumentShareModalProps): React.ReactElement {
    const { onClose, setChrome: _setChrome, ...sheet } = props;
    return <DocumentShareSheet {...sheet} presentation="full" onRequestClose={onClose} />;
}

function LoadedBoardShareIdentity(props: Readonly<{ board: WorkBoardV1; kindLabel: string }>): React.ReactElement {
    const summary = useBoardLiveSummary(props.board);
    if (summary.itemCount === null) return <>{props.kindLabel}</>;
    return <>{props.kindLabel} · {describeBoardItemCount(summary.itemCount, summary.undetermined)}</>;
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
    /** The item's owner can name a kind outside the Artifacts browser vocabulary. */
    kindLabel?: string;
    /** Context only, for example "6 steps". */
    subtitle?: string;
    /** The Share control (or ⋯) it came from; the sheet hangs from it on wide layouts. */
    anchor?: ShareSheetAnchor;
}>): void {
    const { name, kindLabel: ownerKindLabel, subtitle, anchor, ...sheet } = params;
    const kind = classifyArtifactBrowserKind({ id: sheet.artifactId, header: { kind: sheet.kind } }) ?? 'document';
    const kindLabel = ownerKindLabel ?? artifactKindLabel(kind);
    const identity = kind === 'board' ? <BoardShareIdentity artifactId={sheet.artifactId} kindLabel={kindLabel} />
        : [kindLabel, subtitle?.trim()].filter(Boolean).join(' · ');
    presentShareSheet({ component: DocumentShareModal, props: sheet, testID: 'document-share-modal',
        title: t('shareSheet.documents.shareTitle', { name }), subtitle: identity, ...(anchor ? { anchor } : {}) });
}

function IssuedSignedInLinkModal(props: CustomModalInjectedProps & Readonly<{ shareUrl: string; scope: ServerAccountScope }>) {
    return <DocumentSignedInLinkSection value disabled onChange={() => {}} shareUrl={props.shareUrl}
        scope={props.scope} idPrefix="" />;
}

/** Agent replies retain only the release receipt; the answering App receives the capability privately. */
export function showIssuedDocumentSignedInLink(params: Readonly<{ shareUrl: string; scope: ServerAccountScope }>): void {
    presentShareSheet({ component: IssuedSignedInLinkModal, props: params, title: t('botTemplates.signedInLink'),
        testID: 'document-issued-signed-in-link', fit: 'content' });
}
