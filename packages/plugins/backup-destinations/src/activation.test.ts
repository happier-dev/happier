import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { SFTP_BACKUP_DESTINATION_REF_V1 } from '@happier-dev/plugin-sdk';
import * as destinations from './index.js';

const config = {
  endpoint: 'https://objects.example.test:9443/', bucket: 'recovery',
  prefix: 'environments/é folder', region: 'eu-central-1', addressing: 'path',
};

describe('installed S3 destination Actions', () => {
  it.each([
    { id: 's3', config: { endpoint: 'https://objects.example.test', bucket: 'recovery', prefix: 'authored/base' },
      base: { repository: 's3:https://objects.example.test/recovery/authored/base' },
      scoped: { repository: 's3:https://objects.example.test/recovery/authored/base/previews/environment-staging' } },
    { id: 'local', config: { path: '/srv/recovery' },
      base: { repository: '/run/happier/backup/repository', local: { path: '/srv/recovery' } },
      scoped: { repository: '/run/happier/backup/repository/previews/environment-staging',
        local: { path: join('/srv/recovery', 'previews/environment-staging'), mountPath: '/srv/recovery' } } },
    { id: 'sftp', config: { host: 'receiver', username: 'archive', path: '~/authored/base',
      hostKey: 'receiver ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h' },
      base: { repository: 'sftp://archive@receiver/authored/base' },
      scoped: { repository: 'sftp://archive@receiver/authored/base/previews/environment-staging' } },
  ])('applies captured ownership inside the authored $id namespace exactly once', async ({ id, config, base, scoped }) => {
    const authored = structuredClone(config);
    const fixture = await createPluginTestkit({ manifest: destinations.manifest, module: destinations });
    try {
      const descriptor = destinations.manifest.contributes?.backupDestinations?.find(item => item.id === id)!;
      expect(await fixture.invokeAction(descriptor.actions.open.localId, { config, ownershipPrefix: '' })).toMatchObject(base);
      expect(await fixture.invokeAction(descriptor.actions.open.localId, { config,
        ownershipPrefix: 'previews/environment-staging' })).toMatchObject(scoped);
      for (const ownershipPrefix of ['previews\\..\\outside', '..', 'previews/../outside', '/outside',
        'C:\\outside', 'C:/outside', 'previews//outside', 'previews/./outside', 'previews/\u0000outside']) {
        await expect(fixture.invokeAction(descriptor.actions.open.localId, { config, ownershipPrefix })).rejects.toMatchObject({
          name: 'PluginError', code: 'plugin_action_execution_failed',
        });
      }
      expect(config).toEqual(authored);
    } finally { await fixture.dispose(); }
  });
  it('opens local and SFTP destinations through the installed family with transport-specific custody', async () => {
    const fixture = await createPluginTestkit({ manifest: destinations.manifest, module: destinations });
    try {
      const all = destinations.manifest.contributes?.backupDestinations ?? [];
      expect(all.map(item => item.id).sort()).toEqual(['local', 's3', 'sftp']);
      for (const [id, config, repository, roles] of [
        ['local', { path: '/srv/recovery' }, '/run/happier/backup/repository', ['repositoryPassword']],
        ['sftp', { host: '2001:db8::1', port: 2222, username: 'archive', path: '/repository/é folder',
          hostKey: '[2001:db8::1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h' },
          'sftp://archive@[2001:db8::1]:2222//repository/%C3%A9%20folder', ['repositoryPassword', 'sshPrivateKey']],
      ] as const) {
        const descriptor = all.find(item => item.id === id)!;
        const opened = await fixture.invokeAction(descriptor.actions.open.localId, { config, credentialRoles: roles });
        expect(opened).toMatchObject({ repository, credentialBindings: roles.map(role => ({ purpose: 'backupDestination', configKey: 'destination', role })) });
        expect(opened).toHaveProperty(id, id === 'local' ? config : { host: config.host, port: config.port,
          username: config.username, hostKey: config.hostKey });
        await expect(fixture.invokeAction(descriptor.actions.open.localId, { config,
          credentialRoles: [...roles, 'accessKeyId'] })).rejects.toThrow();
      }
      expect(destinations.manifest.id).toBe(SFTP_BACKUP_DESTINATION_REF_V1.pluginId);
      const sftp = all.find(item => item.id === SFTP_BACKUP_DESTINATION_REF_V1.localId)!;
      for (const [path, username, repository] of [['/', 'archive', 'sftp://archive@receiver//'],
        ['~/backups/', 'archive', 'sftp://archive@receiver/backups/'],
        ['/backups', 'DOMAIN\\archive', 'sftp://DOMAIN%5Carchive@receiver//backups']] as const) {
        expect(await fixture.invokeAction(sftp.actions.open.localId, { config: { host: 'receiver', username, path,
          hostKey: 'receiver ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h' } }))
          .toMatchObject({ repository });
      }
    } finally { await fixture.dispose(); }
  });
  it('opens the selected descriptor through ordinary activation without materializing credentials', async () => {
    const fixture = await createPluginTestkit({ manifest: destinations.manifest, module: destinations });
    try {
      const descriptor = destinations.manifest.contributes?.backupDestinations?.find(item => item.id === 's3');
      expect(descriptor).toBeDefined();
      if (!descriptor) throw new Error('S3 destination is missing');
      expect(descriptor.actions.open.pluginId).toBe(destinations.manifest.id);
      expect(descriptor.credentialRoles).toEqual([
        { role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' },
        { role: 'sessionToken', optional: true },
      ]);
      expect(await fixture.invokeAction(descriptor.actions.open.localId, {
        config, credentialRoles: ['sessionToken', 'repositoryPassword', 'accessKeyId', 'secretAccessKey'],
      })).toEqual({
        repository: 's3:https://objects.example.test:9443/recovery/environments/%C3%A9%20folder',
        credentialBindings: ['repositoryPassword', 'accessKeyId', 'secretAccessKey', 'sessionToken'].map(role => ({
          purpose: 'backupDestination', configKey: 'destination', role,
        })),
        s3: { region: 'eu-central-1', addressing: 'path' },
      });
      expect(descriptor.actions.test).toEqual({ kind: 'hostAction', actionId: 'deployments.backups.test' });
      expect(destinations.manifest.contributes?.actions?.some(action => action.id === 's3/test')).toBe(false);
    } finally { await fixture.dispose(); }
  });

  it('refuses raw credentials, malformed config and incomplete role selection through the Action boundary', async () => {
    const fixture = await createPluginTestkit({ manifest: destinations.manifest, module: destinations });
    try {
      const descriptor = destinations.manifest.contributes?.backupDestinations?.find(item => item.id === 's3');
      expect(descriptor).toBeDefined();
      if (!descriptor) throw new Error('S3 destination is missing');
      for (const input of [
        { config: { ...config, secretAccessKey: 'not-config' } },
        { config: { ...config, endpoint: 'https://user:password@objects.example.test' } },
        { config: { ...config, prefix: 'a/../foreign' } },
        { config, credentialRoles: ['repositoryPassword', 'accessKeyId'] },
        { config, credentialRoles: ['repositoryPassword', 'accessKeyId', 'secretAccessKey', 'sshPrivateKey'] },
        { config, credentialBindings: [{ value: 'not-a-handle' }] },
      ]) await expect(fixture.invokeAction(descriptor.actions.open.localId, input)).rejects.toThrow();
    } finally { await fixture.dispose(); }
  });
});
