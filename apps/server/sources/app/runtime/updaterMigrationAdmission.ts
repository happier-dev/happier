import {
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV,
} from '@happier-dev/cli-common/firstPartyRuntime/server';

/** Irreversible migrations require the candidate to refuse
 * before database mutation unless the invoking updater can recover forward. */
export function assertForwardRecoveryCapableUpdater(env: NodeJS.ProcessEnv): void {
    if (String(env[PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV] ?? '').trim()
        !== PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY) {
        throw new Error(
            'This irreversible migration requires a forward-recovery-capable updater. '
            + 'Update the Happier CLI/installer, stop all server processes sharing this database, '
            + 'and retry the update through the managed Personal Home installer. '
            + 'Stack startup does not provide this recovery contract; for a shared-DB QA server, '
            + 'set HAPPIER_SQLITE_AUTO_MIGRATE=0 and HAPPIER_STACK_MIGRATE_MODE=skip after the database owner has migrated it. '
            + 'Do not set HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY manually or restart an older server against migrated data.',
        );
    }
}
