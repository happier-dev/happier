import { afterEach, describe, expect, it } from 'vitest';
import { parseOrganizationPolicyV1 } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readSettings } from '@/persistence';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, removeServerProfile, setServerProfileEndpointsById, upsertServerProfileByUrl, useServerProfile } from './serverProfiles';
import { applyEphemeralServerSelectionFromPrefixArgs } from './serverSelection';

describe('organization Home profile selection writes', () => {
  const originalPolicy = configuration.organizationPolicy;
  const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
  afterEach(() => {
    Object.defineProperty(configuration, 'organizationPolicy', { value: originalPolicy });
    scope.restore();
    reloadConfiguration();
  });

  it('blocks alternate ingress while permitting the mandated Home and retaining the prior choice after removal', async () => {
    await withTempDir('org-policy-profiles-', async (homeDir) => {
      scope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const previous = await addServerProfile({ name: 'mine', serverUrl: 'https://mine.example', webappUrl: 'https://mine.example', use: true });
      Object.defineProperty(configuration, 'organizationPolicy', { value: parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","home":{"url":"https://company.example","locked":true}}') });
      await expect(useServerProfile(previous.id)).rejects.toMatchObject({ code: 'organization_policy_locked' });
      await expect(applyEphemeralServerSelectionFromPrefixArgs(['--server-url', 'https://outside.example', 'status'])).rejects.toMatchObject({ code: 'organization_policy_locked' });
      await expect(addServerProfile({ name: 'other', serverUrl: 'https://outside.example', webappUrl: 'https://outside.example', use: true })).rejects.toMatchObject({ code: 'organization_policy_locked' });
      await expect(upsertServerProfileByUrl({ name: 'mine', serverUrl: previous.serverUrl, webappUrl: previous.webappUrl, use: true })).rejects.toMatchObject({ code: 'organization_policy_locked' });
      await expect(setServerProfileEndpointsById({ id: previous.id, serverUrl: 'https://outside.example', webappUrl: 'https://outside.example', use: true })).rejects.toMatchObject({ code: 'organization_policy_locked' });
      await expect(removeServerProfile(previous.id, { force: true })).rejects.toMatchObject({ code: 'organization_policy_locked' });
      expect((await readSettings()).activeServerId).toBe(previous.id);
      Object.defineProperty(configuration, 'organizationPolicy', { value: { status: 'absent' } });
      expect((await useServerProfile(previous.id)).id).toBe(previous.id);
      Object.defineProperty(configuration, 'organizationPolicy', { value: parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","home":{"url":"https://company.example","locked":true}}') });
      expect((await addServerProfile({ name: 'company', serverUrl: 'https://company.example/', webappUrl: 'https://company.example', use: true })).serverUrl).toBe('https://company.example/');
    });
  });

  it('invalid policy blocks profile selection before changing persisted settings', async () => {
    await withTempDir('org-policy-profiles-invalid-', async (homeDir) => {
      scope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const previous = await addServerProfile({ name: 'mine', serverUrl: 'https://mine.example', webappUrl: 'https://mine.example', use: true });
      Object.defineProperty(configuration, 'organizationPolicy', { value: { status: 'invalid', error: { path: '$', code: 'invalid_json' } } });
      await expect(useServerProfile(previous.id)).rejects.toMatchObject({ code: 'organization_policy_invalid' });
      await expect(applyEphemeralServerSelectionFromPrefixArgs(['--server-url', 'https://outside.example', 'status'])).rejects.toMatchObject({ code: 'organization_policy_invalid' });
      expect((await readSettings()).activeServerId).toBe(previous.id);
    });
  });

  it.each(['locked', 'invalid'] as const)('governs active canonical retarget while retaining same-URL observations with %s policy', async (state) => {
    await withTempDir('org-policy-descriptor-', async (homeDir) => {
      scope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const previous = await addServerProfile({ name: 'company', serverUrl: 'https://company.example', webappUrl: 'https://company.example', use: true });
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_company', canonicalServerUrl: previous.serverUrl, revision: 1, endpoints: [{ kind: 'https' as const, url: previous.serverUrl }] };
      await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: previous.id, observation: 'exact' });
      Object.defineProperty(configuration, 'organizationPolicy', { value: state === 'locked'
        ? parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","home":{"url":"https://company.example","locked":true}}')
        : { status: 'invalid', error: { path: '$', code: 'invalid_json' } } });
      await expect(adoptServerProfileHomeConnectionDescriptor({ descriptor: { ...descriptor, revision: 2 }, expectedProfileId: previous.id, observation: 'exact' })).resolves.toMatchObject({ outcome: 'updated' });
      await expect(adoptServerProfileHomeConnectionDescriptor({ descriptor: { ...descriptor, canonicalServerUrl: 'https://outside.example', revision: 3 }, expectedProfileId: previous.id, observation: 'exact' })).rejects.toMatchObject({ code: `organization_policy_${state}` });
      expect((await readSettings()).servers?.[previous.id]?.serverUrl).toBe(previous.serverUrl);
    });
  });
});
