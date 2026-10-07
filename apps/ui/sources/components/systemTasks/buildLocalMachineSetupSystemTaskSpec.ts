import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';

import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { readActiveServerIdentityForRelayUrl } from '@/sync/domains/server/activeServerTaskScope';

/**
 * Builds the `setup.thisComputer.v1` spec for a desktop-initiated local setup run.
 *
 * The relay pair is **required**: the executor falls back to whatever relay the local CLI happens
 * to have selected when a task supplies no explicit target, so a caller that omits it would
 * silently configure this computer's background service for the wrong Home. Requiring it here
 * makes that omission a compile error at every UI caller. The terminal-initiated `hsetup` path,
 * which legitimately has no app selection to send, keeps the executor's ambient fallback.
 */
export function buildLocalMachineSetupSystemTaskSpec(params: Readonly<{
    activeRelayUrl: string;
    activeWebappUrl: string;
    activeLocalRelayUrl?: string | null;
    /** The Home's server identity, which tells apart CLI profiles sharing its URL (RV-11). */
    activeServerIdentityId?: string | null;
    /**
     * A11-06 — the app's own account on that Home. When this computer's CLI is signed in to
     * another account there, setup claims the pairing for this one instead of reporting the old
     * account as ready. Never the daemon's account.
     */
    activeAccountId?: string | null;
    installService?: boolean;
    startService?: boolean;
    verifyService?: boolean;
    /** Settings › This computer › Command line "Change": ask the one-CLI question again (R12). */
    reconsiderCli?: boolean;
    /** Personal Home recovery Retry: re-apply the recorded one-CLI answer to every service (R12). */
    convergeCliChoice?: boolean;
}>): SystemTaskSpec {
    const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
    // A caller-named Home (the Personal Home bootstrap) keeps its identity; setting up the app's
    // active server names that server's identity (one rule: `readActiveServerTaskScope`).
    const activeServerIdentityId = params.activeServerIdentityId?.trim()
        || readActiveServerIdentityForRelayUrl(params.activeRelayUrl);
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: {
            surface: 'desktop.ui',
            target: 'thisComputer',
            channel,
            ...(typeof params.activeRelayUrl === 'string' && params.activeRelayUrl.trim().length > 0
                ? { activeRelayUrl: params.activeRelayUrl.trim() }
                : {}),
            ...(typeof params.activeWebappUrl === 'string' && params.activeWebappUrl.trim().length > 0
                ? { activeWebappUrl: params.activeWebappUrl.trim() }
                : {}),
            ...(params.activeLocalRelayUrl === null
                ? { activeLocalRelayUrl: null }
                : (typeof params.activeLocalRelayUrl === 'string' && params.activeLocalRelayUrl.trim().length > 0
                    ? { activeLocalRelayUrl: params.activeLocalRelayUrl.trim() }
                    : {})),
            ...(activeServerIdentityId ? { activeServerIdentityId } : {}),
            ...(params.activeAccountId?.trim() ? { activeAccountId: params.activeAccountId.trim() } : {}),
            ...(typeof params.installService === 'boolean' ? { installService: params.installService } : {}),
            ...(typeof params.startService === 'boolean' ? { startService: params.startService } : {}),
            ...(typeof params.verifyService === 'boolean' ? { verifyService: params.verifyService } : {}),
            ...(params.reconsiderCli === true ? { reconsiderCli: true } : {}),
            ...(params.convergeCliChoice === true ? { convergeCliChoice: true } : {}),
        },
    };
}
