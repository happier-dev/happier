import { PluginError } from '@happier-dev/plugin-sdk/errors';

import { bindHostedSessionWorkspaceSource, sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { openSessionHolderWorkspaceClient, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { connectSessionTarget, readSessionTargetPlacement } from '@/subprocess/supervision/sessionTargetRelay';

import { createHolderWorkspaceSource } from './holderWorkspaceSource';

/**
 * The Session runner runs on this Machine; a placed Session's workspace lives in
 * its target. Binds that Session's workspace source (the target, through the
 * primary holder's workspace client over the daemon's relay) so the runner's own
 * workspace work (checkpoints, review fingerprints, media) never reads this
 * Machine's path of the same name. An unplaced Session keeps this Machine's disk.
 */
export function bindPlacedSessionWorkspaceSource(): void {
    const placement = readSessionTargetPlacement(sessionProcessEnvironment());
    if (!placement) return;
    const workspace = placement.launch?.workspace;
    const { primarySocketPath, helperPath } = placement;
    if (!workspace || !primarySocketPath || !helperPath) {
        throw new PluginError({ code: 'agent_cli_target_unavailable', retryable: false,
            message: 'The placed Session has no target workspace for its runner' });
    }
    const target = connectSessionTarget(placement);
    let client: SessionHolderChild | undefined;
    bindHostedSessionWorkspaceSource(createHolderWorkspaceSource({
        id: `${placement.id}:runner`, rootPath: workspace.hostRoot, guestRootPath: workspace.targetRoot, helperPath,
        // Opened on first use (the Agent's holder starts after the runner) and replaced once it loses the holder.
        holder: () => {
            if (!client || client.holderConnectionFailed) {
                client?.detach();
                client = openSessionHolderWorkspaceClient(primarySocketPath, target);
            }
            return client;
        },
    }));
}
