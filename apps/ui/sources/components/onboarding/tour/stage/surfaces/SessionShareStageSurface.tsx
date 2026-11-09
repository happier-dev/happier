import * as React from 'react';

import { SessionAccessEditor } from '@/components/sessions/access/SessionAccessEditor';
import type { SessionAccessEditorActions } from '@/components/sessions/access/sessionAccessEditorTypes';
import { buildDemoSessionShareModel, DEMO_SESSION_SHARE_RESPONSIBLE_ACCOUNT_ID } from '@/demoMode/world/sessionShare';

function noop(): void {}

const actions: SessionAccessEditorActions = {
    setQuery: noop,
    retryContent: noop,
    retryDirectory: noop,
    loadMore: noop,
    addPrincipal: noop,
    retryMutation: noop,
    setAccessLevel: noop,
    setPermissionDelegation: noop,
    requestRemove: noop,
    confirmRemove: noop,
    cancelRemove: noop,
    explain: noop,
    setContext: noop,
    confirmContext: noop,
    cancelContext: noop,
    clearAccess: noop,
    prepareAccess: noop,
    toggleAllRecipients: noop,
    loadMoreRecipients: noop,
};

/** The complete production sharing editor over a read-only, local presentation model. */
export function SessionShareStageSurface(): React.ReactElement {
    const [model] = React.useState(buildDemoSessionShareModel);
    return <SessionAccessEditor model={model} actions={actions} presentation="full"
        responsibleAccountId={DEMO_SESSION_SHARE_RESPONSIBLE_ACCOUNT_ID} testID="session-access-editor" />;
}
