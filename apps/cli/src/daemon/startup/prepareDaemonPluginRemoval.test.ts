import axios from 'axios';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readInstallationIdentityIfExistsSync } from '../identity/store';
import { readServerPluginManagedResources } from '@/plugins/availability/serverPublisher';
import { prepareDaemonPluginRemoval } from './prepareDaemonPluginRemoval';

afterEach(() => vi.restoreAllMocks());

it('binds managed-resource preflight on the first start and retains the installation across starts', async () => {
  await withTempDir('happier-plugin-removal-first-start-', async home => {
    const installationIdentityFile = join(home, 'installation.json');
    expect(readInstallationIdentityIfExistsSync(installationIdentityFile)).toBeNull();
    const params = { credentials: { token: 'fixture-account', encryption: null }, machineId: 'fixture-machine',
      origin: { machineId: 'fixture-machine', serverIdentityId: 'fixture-home' },
      readServerUrl: () => 'https://fixture.example.test', signal: new AbortController().signal,
      installationIdentityFile };
    const first = await prepareDaemonPluginRemoval(params);
    expect(first.managedResourcePreflight).toBeDefined();
    if (!first.managedResourcePreflight) throw new Error('First-start removal preflight was not bound');
    const identity = readInstallationIdentityIfExistsSync(installationIdentityFile);
    expect(identity?.installationId).toBe(first.managedResourcePreflight.controller.installationId);
    // HTTP is the genuine boundary; startup binding, identity storage, request
    // normalization and response parsing all run their production paths.
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {
      availabilityCursor: 0, hostingCapability: { enabled: false }, intent: null,
      release: null, uiArtifacts: [], packageAssets: [], managedResources: [], managedResourcesReviewed: true,
    } });
    await expect(readServerPluginManagedResources(first.managedResourcePreflight, 'happier.agent.pi'))
      .resolves.toEqual({ resources: [], reviewed: true });
    expect(post.mock.calls[0]?.[1]).toMatchObject({ homeId: 'fixture-home',
      controller: { machineId: 'fixture-machine', installationId: identity?.installationId } });
    const second = await prepareDaemonPluginRemoval(params);
    expect(second.installation).toEqual(first.installation);
    expect(second.managedResourcePreflight?.controller).toEqual(first.managedResourcePreflight.controller);
  });
});
