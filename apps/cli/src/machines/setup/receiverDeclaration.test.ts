import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getMachineSetupDesiredV1, type MachineSetupPlanInputV1 } from '@happier-dev/protocol';
import { resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { BACKUP_RECEIVER_RECIPE } from '../../../../../packages/plugins/machine-recipes/src/backupReceiver';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';

describe('restricted receiver declaration through receiving Plan', () => {
  it('projects the actual public-only declaration and binds exact reviewed effects without claiming native SSH readiness', async () => {
    const pluginId = 'happier.machine.recipes';
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '0.0.0', displayName: 'Machine recipes',
      runtime: { apiVersion: 1 }, contributes: { machineRecipes: [{ id: 'backup-receiver', ...BACKUP_RECEIVER_RECIPE }] },
    });
    const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({ provenance: 'external', loadResult: {
      loadedPlugins: [{ pluginId, pluginRootPath: '/plugins/recipes', manifestPath: '/plugins/recipes/plugin.json', daemonEntryPath: null,
        devDaemonEntryPath: null, sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest }],
      diagnosticsByPluginId: {},
    } }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
    const recipes = Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById);
    expect(recipes).toHaveLength(1);
    const chrootPath = `/srv/happier-receiver-${randomUUID()}`;
    const reviewed = { username: 'archive-receiver', chrootPath, repositoryPath: `${chrootPath}/repository`,
      senderPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h',
      connection: { host: 'receiver', address: '192.0.2.2' }, administrator: { username: 'root', host: 'receiver', address: '192.0.2.3' },
      sshServiceUnit: 'ssh.service',
    };
    const input = (inputs: typeof reviewed): MachineSetupPlanInputV1 => ({ homeId: 'home', machineId: 'receiving-machine', sources: [
      { kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection: {
        ref: { pluginId, recipeId: 'backup-receiver', revision: '1' }, inputs,
      } }] } },
    ] });
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Plan cannot publish desired setup'); },
    });
    let nativeReads = 0;
    const effects: string[] = [];
    const prepare = (inputs: typeof reviewed) => prepareMachineSetupPlanV1({ current, input: input(inputs), readRecipes: async () => recipes,
      runNative: async command => {
        nativeReads++;
        if (command.executable === 'getent') {
          if (command.args.at(-1) !== 'root') return { code: 2, stdout: '', stderr: '' };
          return { code: 0, stdout: command.args.includes('passwd') ? 'root:x:0:0:root:/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
        }
        if (command.executable === 'systemctl') return { code: 0, stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' };
        effects.push(command.executable);
        throw new Error('Plan cannot mutate native state');
      },
    });
    const result = await prepare(reviewed);
    if ('ok' in result) throw new Error(`Receiver declaration was refused: ${result.errorCode}`);
    const plan = result.recipePlans?.[0]?.plan;
    if (!plan) throw new Error('Receiver declaration did not produce an effect plan');
    expect(plan.basis).toMatchObject({ kind: 'setup', machineId: 'receiving-machine', selection: { inputs: reviewed } });
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user', username: reviewed.username, ownershipMarker: 'happier-backup-receiver-archive-receiver', supplementaryGroups: [] }),
      expect.objectContaining({ kind: 'directory', path: chrootPath, owner: 'root', protectedAncestors: true }),
      expect.objectContaining({ kind: 'directory', path: reviewed.repositoryPath, owner: reviewed.username, group: reviewed.username }),
      expect.objectContaining({ kind: 'serviceUnit', unit: 'ssh.service' }),
    ]));
    const key = plan.steps.find(step => step.id === 'sender-key');
    if (key?.kind !== 'file' || key.content?.kind !== 'literal') throw new Error('Sender key was not rendered');
    expect(key).toMatchObject({ path: '/etc/ssh/happier-backup-keys/archive-receiver', owner: 'root',
      content: { value: `restrict,command="internal-sftp" ${reviewed.senderPublicKey}\n` } });
    const removal = recipes[0]!.definition.removeSteps!.map(step => resolveMachineRecipeStepInputsV1(step, reviewed));
    expect(removal.find(step => step.id === 'sender-key')).toMatchObject({ state: 'absent',
      expectedContentDigest: createHash('sha256').update(key.content.value).digest('hex') });
    expect(removal.some(step => step.kind === 'directory')).toBe(false);
    const policy = plan.steps.find(step => step.id === 'receiver-ssh-policy');
    if (policy?.kind !== 'file' || policy.content?.kind !== 'literal') throw new Error('Receiver SSH policy was not rendered');
    expect(policy.content.value).toContain(`ChrootDirectory "${chrootPath}"`);
    expect(policy.content.value).toContain('Match all\n');
    expect(policy.probe).toEqual({ kind: 'sshd', contexts: [
      { user: reviewed.username, ...reviewed.connection, expected: {
        chrootdirectory: chrootPath, forcecommand: 'internal-sftp', authenticationmethods: 'publickey', pubkeyauthentication: 'yes',
        passwordauthentication: 'no', kbdinteractiveauthentication: 'no', disableforwarding: 'yes', permittty: 'no',
        permittunnel: 'no', permituserrc: 'no', authorizedkeysfile: '/etc/ssh/happier-backup-keys/archive-receiver',
      } }, { user: 'root', host: 'receiver', address: '192.0.2.3' },
    ] });
    expect(removal.find(step => step.id === policy.id)).toMatchObject({ validate: { kind: 'sshd', contexts: [
      { user: 'root', host: 'receiver', address: '192.0.2.3' },
    ] } });
    expect(plan.nativeFacts.find(fact => fact.stepId === policy.id)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
    expect(result.support[0]?.status).not.toBe('satisfied');
    expect(effects).toEqual([]);
    for (const inputs of [{ ...reviewed, repositoryPath: `${chrootPath}-foreign/repository` },
      { ...reviewed, senderPublicKey: `command="sh" ${reviewed.senderPublicKey}` }]) {
      nativeReads = 0;
      expect(await prepare(inputs)).toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
      expect(nativeReads).toBe(0);
    }
  });
});
