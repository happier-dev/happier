import * as React from 'react';
import { View } from 'react-native';

import { ScmCommitSelectionToggleButton } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { ScmChangeDiscardButton } from '@/components/sessions/sourceControl/changes/ScmChangeDiscardButton';
import { ScmChangeOverflowMenu } from '@/components/sessions/sourceControl/changes/ScmChangeOverflowMenu';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type SessionFilesRowRenderers = Readonly<{
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;
}>;

export function useSessionFilesRowRenderers(input: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    isSelectedForCommit: (file: ScmFileStatus) => boolean;
    onRevealInTree: (fullPath: string) => void;
}>): SessionFilesRowRenderers {
    const renderFileActions = React.useCallback((file: ScmFileStatus) => {
        const selectedForCommit = input.isSelectedForCommit(file);

        return (
            <ScmCommitSelectionToggleButton
                sessionId={input.sessionId}
                sessionPath={input.sessionPath}
                snapshot={input.snapshot}
                scmWriteEnabled={input.scmWriteEnabled}
                commitStrategy={input.scmCommitStrategy}
                file={file}
                selectedForCommit={selectedForCommit}
                surface="files"
            />
        );
    }, [input.isSelectedForCommit, input.scmCommitStrategy, input.scmWriteEnabled, input.sessionId, input.sessionPath, input.snapshot]);

    const renderFileTrailingActions = React.useCallback((file: ScmFileStatus) => {
        const discardEnabled = input.scmWriteEnabled && input.snapshot?.capabilities?.writeDiscard === true;

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {discardEnabled ? (
                    <ScmChangeDiscardButton
                        sessionId={input.sessionId}
                        sessionPath={input.sessionPath}
                        snapshot={input.snapshot}
                        scmWriteEnabled={input.scmWriteEnabled}
                        commitStrategy={input.scmCommitStrategy}
                        file={file}
                        surface="files"
                    />
                ) : null}
                <ScmChangeOverflowMenu
                    title={file.fileName}
                    filePath={file.fullPath}
                    onRevealInTree={() => {
                        input.onRevealInTree(file.fullPath);
                    }}
                />
            </View>
        );
    }, [input.onRevealInTree, input.scmCommitStrategy, input.scmWriteEnabled, input.sessionId, input.sessionPath, input.snapshot]);

    return { renderFileActions, renderFileTrailingActions };
}
