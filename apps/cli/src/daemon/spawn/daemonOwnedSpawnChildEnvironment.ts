import { configuration } from '@/configuration';

/**
 * The daemon's Home and server identity every process it launches for Sessions inherits (a runner,
 * or the session host): the launch strips ambient session-control keys, so these are handed over
 * explicitly from the daemon's configuration.
 */
export function buildDaemonOwnedSpawnChildEnv(): Record<string, string> {
    return {
        HAPPIER_HOME_DIR: configuration.happyHomeDir,
        HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID:
            String(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? '').trim()
            || configuration.activeServerId,
        HAPPIER_SERVER_URL: configuration.serverUrl,
        // Process-local carrier listeners belong to the daemon. The surviving runner
        // acquires its own carrier; URL-only Homes keep this configured route.
        HAPPIER_LOCAL_SERVER_URL: configuration.apiServerUrl,
        HAPPIER_PUBLIC_SERVER_URL: configuration.publicServerUrl,
        HAPPIER_WEBAPP_URL: configuration.webappUrl,
    };
}
