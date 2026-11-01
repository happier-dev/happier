import { expect, it } from 'vitest';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { PLUGIN_MANIFEST } from './manifest.js';

it('installs and removes the managed desktop prerequisites through the virtual-display recipe', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === 'virtual-display');
  const packages = ['xvfb', 'openbox', 'at-spi2-core', 'dbus', 'libglib2.0-bin'].map(name => ({ name }));
  expect(recipe?.steps).toEqual([{ id: 'display-packages', kind: 'package', manager: 'apt', packages }]);
  expect(recipe?.removeSteps).toEqual([{ id: 'display-packages', kind: 'package', manager: 'apt', state: 'absent', packages }]);
});

it('publishes journal access only as a reviewed existing-group daemon membership with exact revocation', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const journal = parsed.manifest.contributes.machineRecipes?.find(recipe => recipe.id === 'journal-reader');
  expect(journal).toBeDefined();
  expect(journal?.revision).toBe('1');
  const group = { kind: 'input', path: 'journalGroup' };
  expect(journal?.steps).toMatchObject([{ id: 'journal-access', kind: 'group', name: group, members: ['happier'], existingOnly: true,
    requiredFacts: [{ kind: 'journalReadGroup', group }] }]);
  expect(journal?.steps).toHaveLength(1);
  expect(journal?.removeSteps).toMatchObject([{ id: 'journal-access', kind: 'group', name: group, members: ['happier'], existingOnly: true, state: 'absent' }]);
  expect(journal?.removeSteps).toHaveLength(1);
  if (!journal) throw new Error('Journal reader declaration is absent');
  const validator = compilePluginJsonSchema(journal.inputSchema);
  expect(isValidPluginJsonSchemaValue(validator, { journalGroup: 'systemd-journal' })).toBe(true);
  expect(isValidPluginJsonSchemaValue(validator, { journalGroup: 'adm' })).toBe(true);
  for (const inputs of [{}, { journalGroup: '--root' }, { journalGroup: 'adm\n' },
    { journalGroup: 'adm', members: ['happier-agent'] }, { journalGroup: 'adm', daemonUsername: 'happier-agent' }]) {
    expect(isValidPluginJsonSchemaValue(validator, inputs)).toBe(false);
  }
});

it('publishes software as cold declarations without an executable or action registration', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  expect(parsed.manifest.entrypoints?.daemon).toBeUndefined();
  expect(parsed.manifest.contributes.actions ?? []).toEqual([]);
  expect(parsed.manifest.contributes.machineRecipes).toEqual(expect.arrayContaining(
    ['fonts', 'ffmpeg', 'virtual-display'].map(id => expect.objectContaining({ id, revision: '1', software: true })),
  ));
});

it('publishes an opt-in restricted receiver with exact reviewed removal and both SSH probe contexts', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const receiver = parsed.manifest.contributes.machineRecipes?.find(recipe => recipe.id === 'backup-receiver');
  expect(receiver).toBeDefined();
  expect(receiver?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  expect(receiver?.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'user', locked: true, supplementaryGroups: [], ownershipMarker: expect.any(Object) }),
    expect.objectContaining({ kind: 'directory', owner: 'root', mode: 0o755, protectedAncestors: true }),
    expect.objectContaining({ kind: 'file', owner: 'root', validate: { kind: 'sshd', contexts: [
      expect.objectContaining({ user: { kind: 'input', path: 'username' } }),
      expect.objectContaining({ user: { kind: 'input', path: 'administrator.username' } }),
    ] } }),
  ]));
  expect(receiver?.removeSteps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'file', state: 'absent', expectedContentDigest: { kind: 'renderedContent', content: expect.any(Object) } }),
    expect.objectContaining({ kind: 'user', state: 'absent', ownershipMarker: expect.any(Object) }),
  ]));
  expect(receiver?.removeSteps?.some(step => step.kind === 'directory')).toBe(false);
});

it('admits only a dedicated login, reviewed paths and single-line public sender keys', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const receiver = parsed.manifest.contributes.machineRecipes?.find(recipe => recipe.id === 'backup-receiver');
  if (!receiver) throw new Error('Restricted receiver declaration is absent');
  const validator = compilePluginJsonSchema(receiver.inputSchema);
  const inputs = { username: 'archive-receiver', chrootPath: '/srv/archives', repositoryPath: '/srv/archives/repository',
    senderPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h',
    connection: { host: 'receiver', address: '192.0.2.2' }, administrator: { username: 'operator', host: 'receiver', address: '192.0.2.3' },
    sshServiceUnit: 'ssh.service',
  };
  expect(isValidPluginJsonSchemaValue(validator, inputs)).toBe(true);
  expect(isValidPluginJsonSchemaValue(validator, { ...inputs, administrator: { ...inputs.administrator, username: 'root' } })).toBe(true);
  expect(isValidPluginJsonSchemaValue(validator, { ...inputs, previousSenderPublicKey: inputs.senderPublicKey })).toBe(true);
  for (const extra of [{ sshPrivateKey: 'private' }, { repositoryPassword: 'private' }, { password: 'private' }]) {
    expect(isValidPluginJsonSchemaValue(validator, { ...inputs, ...extra })).toBe(false);
  }
  for (const senderPublicKey of [`${inputs.senderPublicKey}\n`, `${inputs.senderPublicKey}\nssh-ed25519 AAAA`,
    `command="sh" ${inputs.senderPublicKey}`, '-----BEGIN OPENSSH PRIVATE KEY-----']) {
    expect(isValidPluginJsonSchemaValue(validator, { ...inputs, senderPublicKey })).toBe(false);
  }
  for (const username of ['root', 'happier', 'happier-agent', 'backup', 'docker', 'sudo', 'systemd-network', 'archive\n']) {
    expect(isValidPluginJsonSchemaValue(validator, { ...inputs, username })).toBe(false);
  }
  for (const chrootPath of ['/srv/%h', '/srv/"escape', '/srv/escape\n']) {
    expect(isValidPluginJsonSchemaValue(validator, { ...inputs, chrootPath })).toBe(false);
  }
});
