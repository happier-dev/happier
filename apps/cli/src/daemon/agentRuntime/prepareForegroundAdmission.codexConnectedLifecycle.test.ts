import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConnectedAccountRequestAuthCapabilityDocument } from '@happier-dev/agents/request-auth';

import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { createCodexForegroundConnectedAccountFixture } from './prepareForegroundAdmission.codexConnectedServices.testkit';

const claimInput = {
  canonicalSessionId: 'canonical-session-codex', httpPort: 40123,
  foregroundSatisfiedProfileSecretRequirementNames: [],
} as const;

describe('foreground Codex Connected Account lifecycle through real materialization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('binds request-auth to the exact claimed Session and reuses the materializer-owned native home until cleanup', async () => {
    const account = await createCodexForegroundConnectedAccountFixture();
    try {
      await withRealForegroundAdmissionFixture({ runtimeOptions: account.runtimeOptions }, async (fixture) => {
        const admitted = await fixture.prepare({ connectedServices: account.connectedServices }, await account.dependenciesFor(fixture.runtime.registry, fixture.directory));
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) throw new Error(admitted.error.code);
        const materialized = account.materializations[0];
        if (!materialized) throw new Error('Real Codex materialization was not prepared');
        const nativeHome = materialized.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY];
        if (!nativeHome) throw new Error('Codex materializer did not publish native-home custody');
        const nativeAuth = await readFile(join(nativeHome, 'auth.json'), 'utf8');
        expect(JSON.parse(nativeAuth)).toMatchObject({ tokens: { access_token: 'work-access', refresh_token: 'work-refresh' } });
        const claimed = await admitted.prepared.claim(claimInput);
        expect(claimed.ok).toBe(true);
        if (!claimed.ok) throw new Error(claimed.error.code);
        expect(claimed.environment.CODEX_HOME).toBe(nativeHome);
        await expect(readFile(join(nativeHome, 'auth.json'), 'utf8')).resolves.toBe(nativeAuth);
        const capabilityPath = claimed.environment.HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH;
        if (!capabilityPath) throw new Error('Codex request-auth capability was not published');
        const capability = parseConnectedAccountRequestAuthCapabilityDocument(JSON.parse(await readFile(capabilityPath, 'utf8')));
        if (!capability) throw new Error('Codex request-auth capability is malformed');
        const subject = account.requestAuthRegistry.authenticate(capability.capability);
        if (!subject) throw new Error('Codex request-auth subject is not active');
        expect(subject.subjectId).toBe(`agent-session:${claimInput.canonicalSessionId}`);
        expect(subject.legacyServiceKeyedCompatibility).toBe(true);
        expect(subject.listPurposeUses().map(use => use.binding)).toEqual([account.binding]);
        await admitted.prepared.cleanup();
        expect(subject.isCurrent()).toBe(false);
        expect(account.requestAuthRegistry.authenticate(capability.capability)).toBeNull();
        await expect(stat(capabilityPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(nativeHome)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } finally {
      await account.cleanup();
    }
  });

  it('removes prepared native-home material when the real foreground process exits before claim', async () => {
    const account = await createCodexForegroundConnectedAccountFixture();
    try {
      await withRealForegroundAdmissionFixture({ runtimeOptions: account.runtimeOptions }, async (fixture) => {
        const admitted = await fixture.prepare({ connectedServices: account.connectedServices }, await account.dependenciesFor(fixture.runtime.registry, fixture.directory));
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) throw new Error(admitted.error.code);
        const nativeHome = account.materializations[0]?.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY];
        if (!nativeHome) throw new Error('Prepared Codex native home is unavailable');
        await expect(stat(nativeHome)).resolves.toBeTruthy();
        process.kill(fixture.foregroundPid);
        expect(await waitForProcessExit(fixture.foregroundPid)).toBe(true);
        await expect(admitted.prepared.claim(claimInput)).resolves.toMatchObject({
          ok: false, error: { code: 'provider_agent_runtime_unsupported' },
        });
        await expect(stat(nativeHome)).rejects.toMatchObject({ code: 'ENOENT' });
        await admitted.prepared.cleanup();
        await expect(stat(nativeHome)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } finally {
      await account.cleanup();
    }
  });

});
