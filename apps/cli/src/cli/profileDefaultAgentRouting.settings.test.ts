import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { fetchCustomProfilesForProfileRouting } from './profileDefaultAgentRouting';

describe('profile routing settings', () => {
  let directory: string;
  const originalDirectory = configuration.activeServerDir;
  const originalRequirement = configuration.clientEncryptionRequirement;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-profile-routing-'));
    Object.assign(configuration, { activeServerDir: directory, clientEncryptionRequirement: 'follow_account' });
    resetInMemoryAccountSettingsContextForTests();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetInMemoryAccountSettingsContextForTests();
    Object.assign(configuration, { activeServerDir: originalDirectory, clientEncryptionRequirement: originalRequirement });
    await rm(directory, { recursive: true, force: true });
  });
  it('waits for first settings before choosing a custom profile', async () => {
    // HTTP is external; bootstrap, account scope, disk cache, schema and profile lookup remain real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { version: 1, content: { t: 'plain', v: {
      profiles: [{ id: 'work', name: 'Work', defaultBackendTargetKey: 'agent:codex' }],
    } } } });
    const profiles = await fetchCustomProfilesForProfileRouting({ token: 'routing-test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } });
    expect(profiles.map((profile) => profile.id)).toContain('work');
  });
});
