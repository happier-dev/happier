import type { OwnServerEnvironmentConfigurationV1 } from '@happier-dev/deployment-protocol';
import { executeAdmittedServiceCommand, type NativeComposeEnvironmentProject, type NativeComposeProjectRender } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import type { MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { runOwnServerNativePreMigrationBackup, type OwnServerNativeRestoreInput } from './nativeRestore';

type Step = OwnServerDeploymentReceipt['content']['steps'][number];
export const MIGRATION_STEP = 'own-server-migration';
export const MIGRATION_PENDING_CHECK_STEP = 'own-server-migration-pending-check';
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** The admitted receipt owns whether this operation may dispatch a command.
 * Unsettled native work is reconciled at the next admission, never replayed.
 */
export function admitOwnServerMigration(steps: readonly Step[]): boolean {
    const previous = steps.find(step => step.id === MIGRATION_STEP);
    if (previous) {
        if (previous.state === 'succeeded' || previous.state === 'skipped') return false;
        return refuse('outcome_unknown');
    }
    const check = steps.find(step => step.id === MIGRATION_PENDING_CHECK_STEP);
    if (check) return refuse(check.state === 'failed' ? 'unsupported_action' : 'outcome_unknown');
    return true;
}

/** One first-runtime-Machine command sequence, recorded in the existing receipt.
 * A lost command result is not permission to replay a migration.
 */
export async function executeOwnServerMigration(input: Readonly<{
    configuration: OwnServerEnvironmentConfigurationV1;
    project: NativeComposeEnvironmentProject;
    render: NativeComposeProjectRender;
    context: MachineNativeEffectContext;
    signal: AbortSignal;
    directUrlBound: boolean;
    writeStep(step: Step): Promise<void>;
    /** Lazily acquire the existing backup phase only after pending work is known. */
    prepareBackup?(): Promise<Readonly<{
        input: OwnServerNativeRestoreInput;
        capture: Parameters<typeof runOwnServerNativePreMigrationBackup>[1];
        dispose(): Promise<void>;
    }>>;
}>) {
    const migration = input.configuration.migration;
    if (!migration) return;
    const record = (id: string, state: Step['state']) => input.writeStep({ id,
        label: id === MIGRATION_STEP ? 'Run candidate migration' : 'Check candidate migration', state });
    await input.project.prepareRuntimeImages({ render: input.render, context: input.context, signal: input.signal });
    const run = async (argv: readonly string[]) => {
        const command = await input.project.admitServiceCommand({ render: input.render, context: input.context,
            service: migration.service, command: { mode: 'run', argv }, signal: input.signal,
            // Native Compose interpolates the ordinary P42 runtime attachment;
            // no connection value leaves its protected carrier/redaction custody.
            ...(input.directUrlBound ? { environmentOverrides: { DATABASE_URL: '${DIRECT_URL}' } } : {}) });
        return executeAdmittedServiceCommand(command);
    };
    if (migration.pendingCheck) {
        // Declared checks use zero for no work and nonzero for pending work.
        // An unrelated check error also attempts the visible, backed-up migration.
        await record(MIGRATION_PENDING_CHECK_STEP, 'running');
        const result = await run(migration.pendingCheck.argv);
        await record(MIGRATION_PENDING_CHECK_STEP, result.kind === 'outcome_unknown' ? 'outcome_unknown' : 'succeeded');
        if (result.kind === 'outcome_unknown') return refuse('outcome_unknown');
        if (result.exitCode === 0) {
            await record(MIGRATION_STEP, 'skipped');
            return;
        }
    }
    if (input.configuration.backupBeforeMigration !== false) {
        if (!input.prepareBackup) return refuse('backup_required');
        const backup = await input.prepareBackup();
        try { await runOwnServerNativePreMigrationBackup(backup.input, backup.capture); }
        finally { await backup.dispose(); }
    }
    await record(MIGRATION_STEP, 'running');
    const result = await run(migration.argv);
    await record(MIGRATION_STEP, result.kind === 'outcome_unknown' ? 'outcome_unknown'
        : result.exitCode === 0 ? 'succeeded' : 'failed');
    if (result.kind === 'outcome_unknown') return refuse('outcome_unknown');
    if (result.exitCode !== 0) return refuse('deployment_failed');
}
