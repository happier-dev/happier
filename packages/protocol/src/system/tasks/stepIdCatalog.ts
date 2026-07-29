import { z } from 'zod';

/**
 * Canonical system-task step ids (progress/prompt namespaces).
 *
 * These ids are intentionally stable because:
 * - UI uses them to map progress/prompt steps to localized labels.
 * - Tests assert on deterministic step ids for critical setup flows.
 */

export const SETUP_THIS_COMPUTER_SYSTEM_TASK_STEP_IDS_V1 = [
  'setup.thisComputer.ensureCli',
  'setup.thisComputer.resolveRelay',
  'setup.thisComputer.checkAuth',
  'setup.thisComputer.preflight.releaseChannel',
  'setup.thisComputer.preflight.manualRelayTakeover',
  'setup.thisComputer.preflight.serviceConflict',
  'setup.thisComputer.configureRelay',
  'setup.thisComputer.auth.request',
  'setup.thisComputer.auth.wait',
  'setup.thisComputer.installService',
  'setup.thisComputer.startService',
  'setup.thisComputer.verifyService',
] as const;

export const SetupThisComputerSystemTaskStepIdSchema = z.enum(SETUP_THIS_COMPUTER_SYSTEM_TASK_STEP_IDS_V1);
export type SetupThisComputerSystemTaskStepId = z.infer<typeof SetupThisComputerSystemTaskStepIdSchema>;

export const SETUP_REPAIR_THIS_COMPUTER_SYSTEM_TASK_STEP_IDS_V1 = [
  'setup.repairThisComputer.prepare',
  'setup.repairThisComputer.configureRelay',
  'setup.repairThisComputer.authenticate',
  'setup.repairThisComputer.authRequest',
  'setup.repairThisComputer.verifyMachine',
  'setup.repairThisComputer.installService',
  'setup.repairThisComputer.startService',
  'setup.repairThisComputer.waitForReady',
  'setup.repairThisComputer.finish',
] as const;

export const SetupRepairThisComputerSystemTaskStepIdSchema = z.enum(SETUP_REPAIR_THIS_COMPUTER_SYSTEM_TASK_STEP_IDS_V1);
export type SetupRepairThisComputerSystemTaskStepId = z.infer<typeof SetupRepairThisComputerSystemTaskStepIdSchema>;

export const REMOTE_SSH_BOOTSTRAP_MACHINE_SYSTEM_TASK_STEP_IDS_V1 = [
  'ssh.trust',
  'ssh.hostTrust',
  'ssh.auth.request',
  'ssh.auth.approval',
  'ssh.auth.wait',
  'ssh.installCli',
  'relay.runtime.install',
  'ssh.complete',
] as const;

export const RemoteSshBootstrapMachineSystemTaskStepIdSchema = z.enum(REMOTE_SSH_BOOTSTRAP_MACHINE_SYSTEM_TASK_STEP_IDS_V1);
export type RemoteSshBootstrapMachineSystemTaskStepId = z.infer<typeof RemoteSshBootstrapMachineSystemTaskStepIdSchema>;

export const RELAY_CONNECT_BACKGROUND_SERVICE_SYSTEM_TASK_STEP_IDS_V1 = [
  'relay.connectBackgroundService.prepare',
  'relay.connectBackgroundService.configureRelay',
  'relay.connectBackgroundService.authenticate',
  'relay.connectBackgroundService.finish',
] as const;

export const RelayConnectBackgroundServiceSystemTaskStepIdSchema = z.enum(
  RELAY_CONNECT_BACKGROUND_SERVICE_SYSTEM_TASK_STEP_IDS_V1,
);
export type RelayConnectBackgroundServiceSystemTaskStepId = z.infer<
  typeof RelayConnectBackgroundServiceSystemTaskStepIdSchema
>;
