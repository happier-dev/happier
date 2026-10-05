import { AppUpdateActionInputSchemas, type ActionExecutorDeps } from '@happier-dev/protocol';
import type { AppUpdateStatus } from './useAppUpdateStatus';

// The shell summary and the open Updates page consume the same platform owners. Retiring one
// subscriber must leave the other live; no check, download or update state is owned here.
const owners = new Set<() => AppUpdateStatus>();
export function registerAppUpdateActionOwner(read: () => AppUpdateStatus): () => void {
    owners.add(read);
    return () => { owners.delete(read); };
}

export const executeAppUpdateAction: NonNullable<ActionExecutorDeps['appUpdateAction']> = async ({ actionId, input, context }) => {
    context.signal?.throwIfAborted();
    const read = [...owners].at(-1);
    if (!read) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const status = read();
    const { item, channel } = status.model;
    if (actionId === 'app.updates.get') return {
        channel, state: item.state, currentVersion: item.currentVersion, latestVersion: item.latestVersion,
        checkedAt: status.checkedAt, action: item.action.kind === 'run' ? item.action.verb : null,
        skipped: item.skipped, canSkip: status.skipVersion !== null,
    };
    if (actionId === 'app.updates.check') {
        await status.checkNow();
    } else if (actionId === 'app.updates.skip') {
        const { version } = AppUpdateActionInputSchemas[actionId].parse(input);
        if (!status.skipVersion || item.latestVersion !== version) return { ok: false, errorCode: 'app_update_unavailable', error: 'app_update_unavailable' };
        status.skipVersion();
    } else {
        const verb = item.action.kind === 'run' ? item.action.verb : null;
        const available = actionId === 'app.updates.update' ? verb === 'update' || verb === 'reload' || verb === 'store'
            : actionId === 'app.updates.retry' ? verb === 'retry' : verb === 'restart';
        if (!available) return { ok: false, errorCode: 'app_update_unavailable', error: 'app_update_unavailable' };
        await status.run();
    }
    // The platform owner continues to report actual progress/failure through get; dispatch is not
    // a claim that an installation succeeded or that a restarted process acknowledged completion.
    return { status: 'requested' };
};
