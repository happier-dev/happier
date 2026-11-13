import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createMachineSetupNativeBackend, checkMachineSetupEffectPlan, applyMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { googleChrome } from './googleChrome.js';

it.skipIf(process.platform === 'win32').each(['x86_64', 'aarch64'])('installs and replays Chrome on DNF4 %s through its pinned vendor source', async architecture => {
  const root = await mkdtemp(join(tmpdir(), 'happier-chrome-dnf-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const recipe = MachineRecipeV1Schema.parse({ id: 'google-chrome', ...googleChrome });
  const sourcePath = join(root, 'google-chrome.repo'), keyPath = join(root, 'google-chrome.asc');
  const steps = recipe.steps.filter(step => 'manager' in step && step.manager === 'dnf')
    .map(step => resolveMachineRecipeStepInputsV1(step, {}))
    .map(step => step.kind === 'packageSource' ? { ...step, path: sourcePath, keyPath } : step);
  const installed = new Set<string>(), effects: string[] = [];
  let available = false, imported = false, wrongImportedPrimary = false;
  const keyVersion = architecture === 'aarch64' ? 'eb4c1bfd4f042f6dddccec917721f63bd38b4796' : 'd38b4796';
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const armor = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture\n';
  const backend = createMachineSetupNativeBackend({ run: async command => {
    if (command.executable === 'getent') return ok(command.args.includes('passwd')
      ? `root:x:${process.getuid?.()}:${process.getgid?.()}::/root:/bin/sh\n` : `root:x:${process.getgid?.()}:\n`);
    if (command.executable === 'gpg') return installed.has('gnupg2')
      ? ok(`pub:-:4096:1:key:0:0::-:::scSC:\nfpr:::::::::${wrongImportedPrimary && command.inputBytes ? 'A'.repeat(32) + 'D38B4796' : 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796'}:\n`)
      : { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
    if (command.executable === 'curl') {
      if (!installed.has('curl')) return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
      await writeFile(command.args[command.args.indexOf('--output') + 1]!, armor); effects.push('key'); return ok();
    }
    if (command.executable === 'rpm') {
      if (command.args[0] === '--eval') return ok(architecture + '\n');
      if (command.args[0] === '--import') { expect(await readFile(command.args.at(-1)!, 'utf8')).toBe(armor); imported = true; effects.push('trust'); return ok(); }
      if (command.args[0] === '--erase') { installed.delete('google-chrome-stable'); effects.push('remove'); return ok(); }
      if (command.args.includes('gpg-pubkey')) return imported ? ok(keyVersion + '\n') : { code: 1, stdout: 'package gpg-pubkey is not installed\n', stderr: '' };
      if (command.args.at(-1) === 'gpg-pubkey-' + keyVersion) return ok(armor);
      const wanted = command.args.slice(command.args.indexOf('--') + 1);
      return { code: wanted.filter(name => !installed.has(name)).length, stdout: wanted.map(name => installed.has(name)
        ? `${name}\t0:1-1\t${architecture}\n` : `package ${name} is not installed\n`).join(''), stderr: '' };
    }
    if (command.executable === 'dnf') {
      if (command.args[0] === '--version') return ok('4.22.0\n');
      if (command.args.includes('repoquery-n')) {
        const name = command.args.at(-1)!;
        if (name === 'google-chrome-stable') {
          const source = await readFile(sourcePath, 'utf8').catch(() => '');
          available = source.includes(`baseurl=https://dl.google.com/linux/chrome/rpm/stable/${architecture}`)
            && source.includes('gpgcheck=1') && imported;
        }
        return ok(name === 'google-chrome-stable' && !available ? '' : `${name}\t0:1-1\t${architecture}\n`);
      }
      if (command.args.includes('install-nevra')) {
        const wanted = command.args.slice(command.args.indexOf('--') + 1).map(value => value.split('-0:')[0]!);
        for (const name of wanted) installed.add(name);
        effects.push('install:' + wanted.join(','));
        if (wanted.includes('google-chrome-stable')) expect(available && imported).toBe(true);
        return ok();
      }
    }
    throw new Error(`Unexpected native boundary ${command.executable} ${command.args.join(' ')}`);
  } });
  const basis = { kind: 'setup' as const, machineId: 'chrome-dnf-fixture', desiredRevision: 0 };
  const apply = async () => applyMachineSetupEffectPlan({ plan: await checkMachineSetupEffectPlan({ basis, steps, backend }), backend });
  expect(await apply()).toMatchObject({ status: 'applied' });
  expect(installed.has('google-chrome-stable')).toBe(true);
  const first = ['install:ca-certificates,curl,gnupg2', 'key', 'trust', 'install:google-chrome-stable'];
  expect(effects).toEqual(first);
  expect(await apply()).toMatchObject({ status: 'applied' });
  expect(effects).toEqual(first);
  const sourceStep = steps.find(step => step.kind === 'packageSource');
  if (!sourceStep) throw new Error('Expected a declared native source');
  wrongImportedPrimary = true;
  expect(await backend.observe(sourceStep)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
  expect(effects).toEqual(first);
  wrongImportedPrimary = false;
  const source = await readFile(sourcePath, 'utf8');
  const remove = recipe.removeSteps!.filter(step => 'manager' in step && step.manager === 'dnf').map(step => resolveMachineRecipeStepInputsV1(step, {}));
  expect(await applyMachineSetupEffectPlan({ plan: await checkMachineSetupEffectPlan({ basis, steps: remove, backend }), backend })).toMatchObject({ status: 'applied' });
  expect(installed.has('google-chrome-stable')).toBe(false);
  expect(await readFile(sourcePath, 'utf8')).toBe(source);
  expect(imported).toBe(true);
  expect(effects).toEqual([...first, 'remove']);
});
