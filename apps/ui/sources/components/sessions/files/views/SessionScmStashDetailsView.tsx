import * as React from 'react';

import { ScmStashDetailsCore } from '@/components/workspaces/scm/stash/ScmStashDetailsCore';
import type { ScmStashDetailsAdapter } from '@/components/workspaces/scm/stash/scmStashAdapter';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { sessionScmStashDrop, sessionScmStashList, sessionScmStashPop, sessionScmStashShow } from '@/sync/ops';

export type SessionScmStashDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
}>;

export const SessionScmStashDetailsView = React.memo((props: SessionScmStashDetailsViewProps) => {
    const adapter = React.useMemo<ScmStashDetailsAdapter>(() => ({
        list: () => sessionScmStashList(props.sessionId, {}),
        show: (stashRef) => sessionScmStashShow(props.sessionId, { stashRef }),
        pop: (stashRef) => sessionScmStashPop(props.sessionId, { stashRef }),
        drop: (stashRef) => sessionScmStashDrop(props.sessionId, { stashRef }),
    }), [props.sessionId]);

    const handleAfterMutation = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [props.sessionId]);

    return (
        <ScmStashDetailsCore
            adapter={adapter}
            scopeResetKey={`session:${props.sessionId}`}
            onAfterMutation={handleAfterMutation}
            restoreButtonTestId="scm-stash-restore-button"
            discardButtonTestId="scm-stash-discard-button"
            rootTestId="scm-stash-details-root"
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
        />
    );
});
