import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { packageOs, nativeTerminal } from '@/testkit/machines/nativeSoftwareOs';
import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';
import { MachineSetupApplyResultV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { BACKUP_RECEIVER_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { BACKUP_RECEIVER_RECIPE } from '../../../../../packages/plugins/machine-recipes/src/backupReceiver';
import { projectBackupReceiverResults, projectBackupReceiverPlanResults } from './backupReceiverResult';

const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h';
const evidence = { status: 'ready' as const, publicKey, fingerprint: computeSshHostKeyFingerprint(publicKey.split(' ')[1]!) };
const selection = { ref: BACKUP_RECEIVER_RECIPE_REF_V1, inputs: {
  username: 'archive-receiver', chrootPath: '/srv/backups', repositoryPath: '/srv/backups/project/archive',
  senderPublicKey: publicKey, administrator: { username: 'root', host: 'receiver', address: '127.0.0.1' }, sshServiceUnit: 'ssh.service', endpoint: { host: 'fd00::2', port: 2205 },
  connection: { host: 'sender', address: 'fd00::1' },
} };
const identity = { machineId: 'receiver', installationId: 'installation-b' };

describe('receiving daemon backup receiver result', () => {
  it.each([false, 'first', 'later'] as const)('returns the receiver result after native Setup settles (script recovery %s)', async recoverScript => {
    const root = await mkdtemp(join(tmpdir(), 'happier-receiver-action-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const account = userInfo(), keyPath = join(root, 'host_ed25519'), policy = join(root, 'receiver.conf');
    await writeFile(`${keyPath}.pub`, `${publicKey} receiver\n`);
    await writeFile(policy, 'receiver policy', { mode: 0o600 });
    // This declaration isolates the evidence carrier, not receiver provisioning.
    // Home and process IO use the canonical native Software fixture; all Setup
    // preparation, native interpretation, result parsing and projection stay real.
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt', additionalPlugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: BACKUP_RECEIVER_RECIPE_REF_V1.pluginId, version: '1.0.0', displayName: 'Receiver carrier fixture', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: [{ id: BACKUP_RECEIVER_RECIPE_REF_V1.recipeId, revision: '1', title: 'Receiver carrier',
        inputSchema: BACKUP_RECEIVER_RECIPE.inputSchema, steps: [{ id: 'receiver-policy', kind: 'file', path: policy,
          owner: account.username, group: account.username, mode: 0o600, content: { kind: 'literal', value: 'receiver policy' },
          probe: { kind: 'sshd', publicHostKeyEvidence: true, contexts: [{ user: account.username, host: 'sender', address: '127.0.0.1',
            expected: { forcecommand: 'internal-sftp' } }] } }], removeSteps: [] }] },
    } }] });
    packageOs.runNative = async command => {
      if (command.executable === 'getent' && command.args.at(-1) === account.username) return { code: 0, stderr: '', stdout: command.args.includes('passwd')
        ? `${account.username}:x:${account.uid}:${account.gid}:fixture:${account.homedir}:/bin/sh\n` : `${account.username}:x:${account.gid}:\n` };
      if (command.executable === '/usr/sbin/sshd') return { code: 0, stderr: '', stdout: command.args.includes('-T')
        ? `hostkey ${keyPath}\nforcecommand internal-sftp\n` : '' };
      return null;
    };
    const sources = [{ kind: 'direct' as const, setup: { items: [{ kind: 'setupRecipe' as const, selection }],
      ...(recoverScript ? { scripts: [...(recoverScript === 'later' ? [{ body: 'printf FIRST', affects: 'none' as const }] : []),
        { body: 'exit 23', affects: 'none' as const }] } : {}) } }];
    const plan = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({ input: { homeId: 'srv_home',
      machineId: fixture.machine.id, sources, mode: 'effects' }, context: fixture.context('machines.setup.plan') }));
    const input = { homeId: 'srv_home', machineId: fixture.machine.id,
      desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [] };
    if (recoverScript) nativeTerminal.onLaunch = () => queueMicrotask(() =>
      nativeTerminal.exit?.(nativeTerminal.launches.at(-1)?.args.at(-1) === 'exit 23' ? 23 : 0));
    let result = await fixture.apply({ input, context: fixture.context('machines.setup.apply') });
    if (recoverScript) {
      expect(result).toMatchObject({ ok: false, errorCode: 'machine_setup_setup_failed',
        details: { kind: 'finiteCommand', phase: 'setup', step: recoverScript === 'first' ? 0 : 1, exitCode: 23 } });
      expect(await fixture.client.getMachineSetupDesiredSnapshot()).toMatchObject({ status: 'ready',
        policy: { revision: plan.desiredRevision + 1,
          sourceFacts: { direct: { pendingScripts: [recoverScript === 'first' ? 0 : 1] } } } });
      const context = fixture.context('machines.setup.apply', 'receiver-retry');
      const authorization = context.externalActionExecutionAuthorization!;
      context.externalActionExecutionAuthorization = { ...authorization, binding: { ...authorization.binding,
        workflowActionOrigin: { runId: 'receiver-setup', requestId: 'receiver-retry' } } };
      const recipeEffects = fixture.rootLaunches.length;
      nativeTerminal.onLaunch = () => queueMicrotask(() => nativeTerminal.exit?.(0));
      result = await fixture.apply({ input, context });
      expect(fixture.rootLaunches).toHaveLength(recipeEffects);
      // A resumed script does not repeat the native SSH probe or claim old Plan evidence.
      expect(result).toMatchObject({ backupReceivers: [{ status: 'unavailable', machineId: fixture.machine.id,
        endpoint: selection.inputs.endpoint, reason: 'ssh_configuration_unavailable' }] });
      return;
    }
    expect(result).toMatchObject({ backupReceivers: [{ status: 'ready', machineId: fixture.machine.id,
      installationId: fixture.installation.installationId, endpoint: selection.inputs.endpoint, path: '/project/archive',
      hostKey: `[fd00::2]:2205 ${publicKey}`, fingerprint: evidence.fingerprint }] });
  });

  it('binds the public witness to the selected endpoint and SFTP-visible path in the public setup result', () => {
    const backupReceivers = projectBackupReceiverResults({ ...identity,
      recipes: [{ sourceIndex: 0, itemIndex: 1, selection, evidence }] });
    expect(MachineSetupApplyResultV1Schema.parse({ operationId: 'setup-operation', backupReceivers }))
      .toMatchObject({ backupReceivers: [{ status: 'ready', sourceIndex: 0, itemIndex: 1, ...identity,
        endpoint: { host: 'fd00::2', port: 2205 }, username: 'archive-receiver', path: '/project/archive',
        hostKey: `[fd00::2]:2205 ${publicKey}`, fingerprint: evidence.fingerprint }] });
    expect(projectBackupReceiverResults({ ...identity, recipes: [{ sourceIndex: 0, itemIndex: 1, evidence,
      selection: { ...selection, inputs: { ...selection.inputs, endpoint: { host: 'receiver.example', port: 22 } } } }] }))
      .toMatchObject([{ hostKey: `receiver.example ${publicKey}` }]);
  });

  it('never promotes selection or stale Plan evidence into settled receiver evidence', () => {
    const step = { id: 'policy', kind: 'file' as const, path: '/etc/ssh/sshd_config.d/receiver.conf', owner: 'root', group: 'root',
      mode: 0o600, content: { kind: 'literal' as const, value: 'policy' },
      probe: { kind: 'sshd' as const, contexts: [{ user: 'archive-receiver', host: 'sender', address: '127.0.0.1' }], publicHostKeyEvidence: true as const } };
    const plan = createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: identity.machineId, desiredRevision: 0, selection },
      steps: [step], nativeFacts: [{ stepId: step.id, status: 'satisfied', facts: { sshHostKeyEvidence: evidence } }] });
    const input = { ...identity, entries: [{ sourceIndex: 0, itemIndex: 1, plan }] };
    expect(projectBackupReceiverPlanResults(input)).toMatchObject([{ status: 'ready' }]);
    expect(projectBackupReceiverPlanResults({ ...input, nativeHostKeys: [] }))
      .toMatchObject([{ status: 'unavailable', reason: 'ssh_configuration_unavailable', ...identity }]);
    expect(projectBackupReceiverPlanResults({ ...input, nativeHostKeys: [{ planIndex: 1, stepId: step.id, evidence }] }))
      .toMatchObject([{ status: 'unavailable' }]);
    expect(projectBackupReceiverPlanResults({ ...input, planIndexOffset: 1,
      nativeHostKeys: [{ planIndex: 1, stepId: step.id, evidence }] })).toMatchObject([{ status: 'ready' }]);
  });

  it('reports invalid receiver paths and missing public keys without inventing receiver readiness', () => {
    const project = (inputs: typeof selection.inputs, unavailable?: { status: 'unavailable'; reason: 'host_key_unreadable' }) =>
      projectBackupReceiverResults({ ...identity, recipes: [{ sourceIndex: 0, itemIndex: 1,
        selection: { ...selection, inputs }, ...(unavailable ? { evidence: unavailable } : {}) }] });
    expect(project(selection.inputs)).toMatchObject([{ status: 'unavailable', reason: 'ssh_configuration_unavailable' }]);
    expect(project(selection.inputs, { status: 'unavailable', reason: 'host_key_unreadable' }))
      .toMatchObject([{ status: 'unavailable', reason: 'host_key_unreadable' }]);
    expect(project({ ...selection.inputs, repositoryPath: '/srv/backups-sibling/archive' }))
      .toMatchObject([{ status: 'unavailable', reason: 'receiver_inputs_unavailable' }]);
  });
});
