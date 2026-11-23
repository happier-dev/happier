import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { configuration } from '@/configuration';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('host Action write origin at the archive HTTP boundary', () => {
  it.each(['workflow', 'human', 'unarchive'] as const)('carries only the host Workflow archive origin (%s)', async caller => {
    const sessionId = 'c' + 'a'.repeat(24);
    await readOrCreateInstallationIdentity();
    await updateMachineRegistration(registration => ({
      ...registration,
      machineId: 'archive-machine',
    }));
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, active: false, encryptionMode: 'plain', metadata: '{}' }) } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200,
      data: { success: true, archivedAt: caller === 'unarchive' ? null : 123 } });
    const credentials = { token: 'fixture-token', encryption: null };
    const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: '', mode: 'plain', ctx: null });
    await expect(deps.sessionArchiveSet!({ sessionId, archived: caller !== 'unarchive', context: {
      surface: 'cli', actionCaller: caller === 'human' ? { kind: 'host' } : {
        kind: 'workflowRun', runId: 'host-run', authorization: {
          principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
        },
      },
    } })).resolves.toMatchObject({ ok: true });
    const [, body, options] = post.mock.calls[0]!;
    expect(body).toEqual(caller === 'workflow' ? { originRunId: 'host-run' } : {});
    expect(Boolean(options?.headers?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1])).toBe(caller === 'workflow');
  });
});
