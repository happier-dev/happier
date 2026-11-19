import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileRecordV1Schema, PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
  sealProfileRecordContentV1, type ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';

import { handleProfilesCliCommand } from './profiles';
import * as persistenceModule from '@/persistence';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { artifactListResponse } from '@/testkit/http/artifactHome';

let records: ProfileRecordV1[];

beforeEach(() => {
  records = [];
  resetActiveAccountSettingsSnapshotForTests();
  // Credentials and remote HTTP are the boundaries. Bootstrap, Account
  // lifetime admission, Profile rows, and list projection remain real.
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return {
      status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
    };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
    if (path === '/v2/account/settings') return {
      status: 200, data: { version: 1, content: { t: 'plain', v: {} } },
    };
    if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: {
      status: 'listed', rows: records.map(record => ({ id: record.id, revision: 1,
        content: sealProfileRecordContentV1({ mode: 'plain', material: null, record }) })),
      complete: true, nextCursor: null, referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [],
    } };
    if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 'absent' } };
    if (path === PROFILE_TRANSFER_ROUTE_V1 || path === `${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`) {
      return { status: 200, data: { status: 'absent' } };
    }
    return { status: 404, data: {} };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
  process.exitCode = undefined;
});

async function listProfiles() {
  const output = captureConsoleJsonOutput();
  try {
    await handleProfilesCliCommand({
      args: ['profiles', 'list', '--refresh-settings', '--json'],
      rawArgv: ['happier', 'profiles', 'list', '--refresh-settings', '--json'],
      terminalRuntime: null,
    });
    return output.json();
  } finally { output.restore(); }
}

describe('happier profiles list --json', () => {
  it.each([
    ['missing', null],
    ['obsolete', new persistenceModule.CliReloginRequiredError()],
  ] as const)('lists signed-out profiles when credentials are %s', async (_state, refusal) => {
    const read = vi.spyOn(persistenceModule, 'readStoredCredentials');
    if (refusal) read.mockRejectedValue(refusal);
    else read.mockResolvedValue(null);
    expect(await listProfiles()).toMatchObject({
      ok: true, kind: 'profiles_list', data: { authenticated: false, profiles: [] },
    });
  });

  it('includes custom Account Profile rows when authenticated', async () => {
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue({ token: 'x', encryption: null });
    records = [ProfileRecordV1Schema.parse({ v: 1, id: 'work', enabled: true, promptStack: [], secretBindings: {},
      definition: { kind: 'legacy', profile: {
        id: 'work', name: 'Work', compatibilityByTargetKey: { 'agent:claude': true, 'agent:codex': false },
        envVarRequirements: [
          { name: 'WORK_TOKEN', kind: 'secret', required: true },
          { name: 'WORK_HOST', kind: 'config', required: true },
          { name: 'OPTIONAL_SECRET', kind: 'secret', required: false },
        ],
      } },
    })];
    const payload = await listProfiles();
    expect(payload, JSON.stringify(payload)).toMatchObject({ ok: true, kind: 'profiles_list', data: { authenticated: true,
      profiles: [expect.objectContaining({ id: 'work', name: 'Work', isBuiltIn: false,
        requiredSecretEnvVarNames: ['WORK_TOKEN'], requiredConfigEnvVarNames: ['WORK_HOST'],
        supportedAgentIds: expect.arrayContaining(['claude']),
      })],
    } });
    expect(payload.data.profiles[0].supportedAgentIds).not.toContain('codex');
  });

  it('includes canonical requiresMachineLoginTargetKey without legacy machine-login fields', async () => {
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue({ token: 'x', encryption: null });
    records = [ProfileRecordV1Schema.parse({ v: 1, id: 'custom-acp-login', enabled: true, promptStack: [], secretBindings: {},
      definition: { kind: 'legacy', profile: {
        id: 'custom-acp-login', name: 'Custom ACP Login', authMode: 'machineLogin',
        compatibilityByTargetKey: { 'acpBackend:custom-preset': true },
        requiresMachineLoginTargetKey: 'acpBackend:custom-preset', envVarRequirements: [],
      } },
    })];
    const payload = await listProfiles();
    expect(payload, JSON.stringify(payload)).toMatchObject({ ok: true, data: { profiles: [expect.objectContaining({
      id: 'custom-acp-login', authMode: 'machineLogin',
      requiresMachineLoginTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:custom-preset',
    })] } });
    expect(payload.data.profiles[0]).not.toHaveProperty('requiresMachineLogin');
  });
});
