import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createMachineSetupNativeBackend, checkMachineSetupEffectPlan, applyMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { googleChrome } from './googleChrome.js';

it.skipIf(process.platform === 'win32').each(['amd64', 'arm64'])('installs Chrome on %s from its signed vendor source and accepts its native post-install metadata on replay', async architecture => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'google-chrome', ...googleChrome });
  const root = await mkdtemp(join(tmpdir(), 'happier-chrome-recipe-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'google-chrome.sources'), keyPath = join(root, 'google-chrome.gpg');
  const steps = recipe.steps.filter(step => 'manager' in step && step.manager === 'apt')
    .map(step => resolveMachineRecipeStepInputsV1(step, {}))
    .map(step => step.kind === 'packageSource' ? { ...step, path: sourcePath, keyPath } : step);
  let available = false;
  const installed = new Set<string>();
  const effects: string[] = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  // Only OS commands/network are substituted; declaration parsing, source/key
  // publication, package selection and the effect interpreter remain real.
  const backend = createMachineSetupNativeBackend({ run: async command => {
    if (command.executable === 'getent') return ok(command.args.includes('passwd')
      ? `root:x:${process.getuid?.()}:${process.getgid?.()}::/root:/bin/sh\n` : `root:x:${process.getgid?.()}:\n`);
    if (command.executable === 'dpkg') {
      if (command.args[0] === '--remove') { installed.delete('google-chrome-stable'); effects.push('remove'); return ok(); }
      return ok(architecture + '\n');
    }
    if (command.executable === 'lslocks') return ok('{"locks":[]}');
    if (command.executable === 'curl') {
      if (!installed.has('curl')) return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
      expect(command.args.at(-1)).toBe('https://dl.google.com/linux/linux_signing_key.pub');
      await writeFile(command.args[command.args.indexOf('--output') + 1]!, '-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture\n');
      effects.push('key'); return ok();
    }
    if (command.executable === 'gpg') {
      if (!installed.has('gpg')) return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
      if (command.args.includes('--dearmor')) {
        await writeFile(command.args[command.args.indexOf('--output') + 1]!, 'binary public key'); return ok();
      }
      return ok('pub:-:4096:1:key:0:0::-:::scSC:\nfpr:::::::::EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796:\n');
    }
    if (command.executable === 'dpkg-query') {
      const wanted = command.args.slice(command.args.indexOf('--') + 1);
      return { code: wanted.every(name => installed.has(name)) ? 0 : 1,
        stdout: wanted.filter(name => installed.has(name)).map(name => name + '\tinstall ok installed\t142.0.1\t' + architecture + '\n').join(''), stderr: '' };
    }
    if (command.executable === 'apt-cache') {
      const name = command.args.at(-1)!.split('=')[0]!;
      return ok(!available && name === 'google-chrome-stable' ? 'Candidate: (none)\n' : command.args[0] === 'policy'
        ? 'Candidate: 142.0.1\n  142.0.1 500\n' : 'Package: ' + name + '\nVersion: 142.0.1\nArchitecture: ' + architecture + '\n');
    }
    if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 3.2');
    if (command.executable === 'apt-get' && command.args[0] === 'update') {
      effects.push('refresh');
      const source = await readFile(sourcePath, 'utf8').catch(() => '');
      available = source.includes('URIs: https://dl.google.com/linux/chrome-stable/deb/')
        && source.includes(`Signed-By: ${keyPath}`) && await readFile(keyPath, 'utf8').catch(() => '') === 'binary public key';
      return ok();
    }
    if (command.executable === 'apt-get' && command.args[0] === 'install') {
      const wanted = command.args.slice(command.args.indexOf('--') + 1);
      effects.push('install:' + wanted.join(','));
      for (const name of wanted) installed.add(name);
      if (!wanted.includes('google-chrome-stable')) return ok();
      expect(available).toBe(true);
      // Chromium's current apt.include recreates this same source during postinst.
      const source = (await readFile(sourcePath, 'utf8')).replace(/^Architectures:.*$/m, 'Architectures: ' + architecture);
      await writeFile(sourcePath, `### THIS FILE IS AUTOMATICALLY CONFIGURED ###\nX-Repolib-Name: Google Chrome\n${source}`);
      return ok();
    }
    throw new Error(`Unexpected native boundary ${command.executable}`);
  } });
  const basis = { kind: 'setup' as const, machineId: 'chrome-fixture', desiredRevision: 0 };
  let plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
  expect(effects).toEqual([]);
  let result = await applyMachineSetupEffectPlan({ plan, backend });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
  expect(installed.has('google-chrome-stable')).toBe(true);
  expect(effects).toEqual(['install:ca-certificates,curl,gpg', 'key', 'refresh', 'install:google-chrome-stable']);
  plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
  result = await applyMachineSetupEffectPlan({ plan, backend });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
  expect(effects).toEqual(['install:ca-certificates,curl,gpg', 'key', 'refresh', 'install:google-chrome-stable']);
  const remove = recipe.removeSteps!.filter(step => 'manager' in step && step.manager === 'apt')
    .map(step => resolveMachineRecipeStepInputsV1(step, {}));
  const before = await readFile(sourcePath, 'utf8');
  plan = await checkMachineSetupEffectPlan({ basis, steps: remove, backend });
  expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
  expect(installed.has('google-chrome-stable')).toBe(false);
  expect(effects).toEqual(['install:ca-certificates,curl,gpg', 'key', 'refresh', 'install:google-chrome-stable', 'remove']);
  expect(await readFile(sourcePath, 'utf8')).toBe(before);
  expect(await readFile(keyPath, 'utf8')).toBe('binary public key');
});

it.skipIf(process.platform === 'win32')('accepts vendor deb822 comments and display metadata without accepting a changed repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-chrome-source-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = MachineRecipeV1Schema.parse({ id: 'vendor-source', revision: '1', title: 'Vendor source',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{
      id: 'source', kind: 'packageSource', manager: 'apt', path: join(root, 'google-chrome.sources'), keyPath: join(root, 'google-chrome.gpg'),
      url: 'https://dl.google.com/linux/chrome-stable/deb/', suite: 'stable', components: ['main'], architectures: ['amd64', 'arm64'],
      keyUrl: 'https://dl.google.com/linux/linux_signing_key.pub', keyFingerprint: 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796',
    }] }).steps[0]!;
  if (source.kind !== 'packageSource') throw new Error('Expected a source declaration');
  const metadata = `### THIS FILE IS AUTOMATICALLY CONFIGURED ###\nX-Repolib-Name: Google Chrome\nTypes: deb\nURIs: ${source.url}\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: ${source.keyPath}\n`;
  await writeFile(source.path, metadata, { mode: 0o644 });
  await writeFile(source.keyPath, 'binary public key', { mode: 0o644 });
  const backend = createMachineSetupNativeBackend({ run: async command => {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (command.executable === 'getent') return ok(command.args.includes('passwd')
      ? `root:x:${process.getuid?.()}:${process.getgid?.()}::/root:/bin/sh\n` : `root:x:${process.getgid?.()}:\n`);
    if (command.executable === 'dpkg') return ok('amd64\n');
    if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 3.2');
    if (command.executable === 'gpg') return ok(`pub:-:4096:1:key:0:0::-:::scSC:\nfpr:::::::::${source.keyFingerprint}:\n`);
    throw new Error(`An equivalent existing source needs no effect: ${command.executable}`);
  } });
  const step = resolveMachineRecipeStepInputsV1(source, {});
  expect(await backend.observe(step)).toMatchObject({ status: 'satisfied' });
  await writeFile(source.path, metadata.replace('Architectures: amd64', 'Architectures: arm64'));
  expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
  for (const foreign of [metadata.replace(source.url, 'https://other.example.test/deb/'),
    metadata.replace('URIs:', ' URIs:'), `${metadata}\n${metadata}`]) {
    await writeFile(source.path, foreign);
    expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
  }
});
