import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { runInHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { createRequesterSessionCredentialCustody } from './requesterSessionCredentials';

it('opens each hosted Session custody using its own environment and refuses a different Session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-hosted-custody-'));
  const attribution = { serverId: configuration.activeServerId, accountId: 'requester',
    machineId: 'machine', installationId: 'installation' };
  const credentials = { token: 'requester-test-token', encryption: null } as const;
  try {
    const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory,
      sessionId: 'hosted-session', attribution, credentials });
    const read = (sessionId: string) => runInHostedSessionScope({
      environment: { HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: custody.path,
        HAPPIER_SESSION_REQUESTER_SESSION_ID: sessionId },
    }, readStoredCredentials);
    const [own, other] = await Promise.all([read('hosted-session'), read('different-session')]);
    expect(own?.token).toBe(credentials.token);
    expect(own?.requesterSessionCredentialScope?.requesterSession?.sessionId).toBe('hosted-session');
    expect(other).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
