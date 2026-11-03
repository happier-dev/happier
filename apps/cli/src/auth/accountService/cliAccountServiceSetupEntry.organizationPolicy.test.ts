import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOrganizationPolicyV1 } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { runCliAccountServiceSetupEntry } from './cliAccountServiceSetupEntry';

describe('organization Account Service setup admission', () => {
  const originalPolicy = configuration.organizationPolicy;
  const scope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
    Object.defineProperty(configuration, 'organizationPolicy', { value: originalPolicy });
    scope.restore();
    reloadConfiguration();
  });

  it.each([false, true])('uses policy default and admits its endpoint when locked=%s', async (locked) => {
    await withTempDir('org-policy-account-entry-', async (homeDir) => {
      scope.patch({ HAPPIER_HOME_DIR: homeDir });
      reloadConfiguration();
      const requests: string[] = [];
      server = createServer((request, response) => {
        requests.push(request.url ?? '');
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{}');
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address');
      const endpoint = `http://127.0.0.1:${address.port}`;
      Object.defineProperty(configuration, 'organizationPolicy', { value: parseOrganizationPolicyV1(JSON.stringify({ schemaVersion: 1, organization: 'Example', accountService: { url: endpoint, locked } })) });
      expect(await runCliAccountServiceSetupEntry({})).toMatchObject({ kind: 'account_service_unavailable' });
      expect(requests).toContain('/v1/features');
    });
  });

  it('rejects a locked alternate endpoint and invalid policy before discovery', async () => {
    Object.defineProperty(configuration, 'organizationPolicy', { value: parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","accountService":{"url":"https://company.example","locked":true}}') });
    await expect(runCliAccountServiceSetupEntry({ endpoint: 'https://outside.example' })).rejects.toMatchObject({ code: 'organization_policy_locked' });
    Object.defineProperty(configuration, 'organizationPolicy', { value: { status: 'invalid', error: { path: '$', code: 'invalid_json' } } });
    await expect(runCliAccountServiceSetupEntry({})).rejects.toMatchObject({ code: 'organization_policy_invalid' });
  });
});
