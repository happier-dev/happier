import * as React from 'react';

import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { DiscussionDetailsContentView } from '@/components/discussions/DiscussionDetailsView';
import { DiscussionPaneHost } from '@/components/discussions/DiscussionRightSidebar';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { getDemoModeServerId, isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import { buildDemoDiscussion, buildDemoDiscussionApproval, DEMO_DISCUSSION_ACCOUNT_ID,
    DEMO_DISCUSSION_ID } from '@/demoMode/world/discussion';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { createDiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import type { DiscussionMobileSurface } from '@/components/workspaceCockpit/discussion/discussionCockpitState';

import type { StageDevice } from '../DeviceFrame';

/** Select the actual Agents pane, then return the device's retained pane record on teardown. */
function DiscussionInitialPane(props: Readonly<{ device: StageDevice; scopeId: string;
    previous: ReturnType<typeof paneUiState.readStrict> }>): null {
    const dispatch = useAppPaneContext(value => value.dispatch);
    React.useEffect(() => {
        if (props.device === 'phone') return;
        dispatch({ type: 'openRight', scopeId: props.scopeId, tabId: 'discussionAgents' });
        return () => {
            if (props.previous) paneUiState.set(props.scopeId, props.previous);
            else paneUiState.remove(props.scopeId);
        };
    }, [dispatch, props.device, props.previous, props.scopeId]);
    return null;
}

/** The actual Discussion page over the seeded world's local read boundary. */
export function DiscussionStageSurface(props: Readonly<{ device: StageDevice }>): React.ReactElement {
    const paneScopeId = useDestinationPaneScopeId('discussion');
    const [previousPane] = React.useState(() => paneUiState.readStrict(paneScopeId));
    const [surface, setSurface] = React.useState<DiscussionMobileSurface>('chat');
    const [readContext] = React.useState(() => {
        const serverId = getDemoModeServerId() ?? 'demo-home';
        const scope = { serverId, accountId: DEMO_DISCUSSION_ACCOUNT_ID };
        const { client } = buildDemoDiscussion(serverId);
        const repository = createDiscussionRepository({ scope, address: { serverId }, client });
        // A presentation lifetime, never a credential binding or Action admission.
        const accountLifetime: ServerAccountScopeLifetime = { scope, isCurrent: isDemoModeActive,
            onRetire: () => ({ dispose() {} }) };
        return { scope, client, repository, accountLifetime };
    });
    const snapshot = useDiscussionRepositorySnapshot(readContext.repository);
    React.useEffect(() => {
        const artifact = buildDemoDiscussionApproval(readContext.scope.serverId);
        const state = storage.getState();
        const previous = state.artifacts[artifact.id];
        const previousPresentation = { profileScope: state.profileScope, isDataReady: state.isDataReady,
            artifactInboxLoaded: state.artifactInboxLoaded, artifactInboxPartial: state.artifactInboxPartial };
        // Display-only demo memory: no profile activation, credential binding or Account persistence.
        storage.setState({ profileScope: readContext.scope });
        storage.getState().applyArtifacts([artifact], {}, 'inboxOpen');
        storage.getState().applyReady();
        const unmount = readContext.repository.mount({ discussionId: DEMO_DISCUSSION_ID });
        void readContext.repository.refreshDiscussion(DEMO_DISCUSSION_ID);
        return () => {
            unmount();
            readContext.repository.clear();
            if (previous) storage.getState().updateArtifact(previous);
            else storage.getState().deleteArtifact(artifact.id);
            storage.setState(previousPresentation);
        };
    }, [readContext]);
    const viewProps = { target: { kind: 'discussion' as const,
        address: { serverId: readContext.scope.serverId }, discussionId: DEMO_DISCUSSION_ID },
        scope: readContext.scope, accountLifetime: readContext.accountLifetime,
        repository: readContext.repository, discussionClient: readContext.client,
        snapshot, active: true, standaloneSurface: true };
    const main = <DiscussionDetailsContentView {...viewProps} />;
    return <AppPaneProvider><SurfaceStateSizeProvider size={props.device === 'phone' ? 'phone' : 'pane'}>
        <DiscussionPaneHost discussionId={DEMO_DISCUSSION_ID} scope={readContext.scope}
            paneEnabled={props.device !== 'phone'} phoneSurface={props.device === 'phone' ? surface : null}
            onSurfaceChange={setSurface} onBackToThread={() => setSurface('chat')} main={main} />
        <DiscussionInitialPane device={props.device} scopeId={paneScopeId} previous={previousPane} />
    </SurfaceStateSizeProvider></AppPaneProvider>;
}
