import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('deployment protocol initialization', () => {
  it('loads and consumes deployment schemas in the native source runtime', () => {
    const result = spawnSync(process.execPath, [
      '--conditions=happier-source', '--import', './packages/cli-common/registerSourceRuntime.mjs',
      '--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { readdir } from 'node:fs/promises';
        import { resolve } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const root = './packages/protocol/src/deployments/';
        const actions = await import(root + 'deploymentActionsV1.ts');
        assert.equal(actions.DeploymentEnvironmentHeaderV1Schema.shape.dataAgentAccess.parse('readWriteAsk'), 'readWriteAsk');
        assert.deepEqual(actions.DeploymentEnvironmentUpdatePatchV1Schema.parse({ dataAgentAccess: 'readWriteNoApproval' }),
          { dataAgentAccess: 'readWriteNoApproval' });
        for (const file of (await readdir(root, { recursive: true })).sort()) {
          if (!file.endsWith('.ts') || /\\.(test|spec|testkit|d)\\.ts$/.test(file)) continue;
          const module = await import(pathToFileURL(resolve(root, file)).href);
          for (const [name, value] of Object.entries(module)) {
            if (name.endsWith('Schema') && typeof value?.safeParse === 'function') value.safeParse({});
          }
        }
      `,
    ], { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8' });
    expect(result.status, result.error?.stack ?? result.stderr).toBe(0);
  });
  it.each(['domain-first', 'receipt-first', 'actions-first'])('loads and consumes Domain, scope and header %s', async (order) => {
    vi.resetModules();
    if (order === 'domain-first') await import('./deploymentDomainProviderResultV1.js');
    else if (order === 'receipt-first') await import('./deploymentReceiptEventsV1.js');
    else await import('./deploymentActionsV1.js');
    const { DeploymentTargetDomainResultV1Schema, DeploymentTargetDomainResultV1ProtocolSchema } =
      await import('../plugins/contributions/deploymentTargetRolesV1.js');
    const value = { v: 1, hostname: 'example.test', state: 'active', dns: [] };
    expect(DeploymentTargetDomainResultV1Schema.parse(value)).toEqual(value);
    expect(DeploymentTargetDomainResultV1ProtocolSchema.safeParse(value).success).toBe(true);
    expect(DeploymentTargetDomainResultV1ProtocolSchema.safeParse({ ...value, state: 'invalid' }).success).toBe(false);
    const { DeploymentTargetScopeV1Schema, DeploymentEnvironmentHeaderV1Schema } = await import('./deploymentActionsV1.js');
    const scope = { kind: 'account', accountId: 'account-1' };
    expect(DeploymentTargetScopeV1Schema.parse(scope)).toEqual(scope);
    // Consuming the header must return a validation result, even for missing fields.
    expect(DeploymentEnvironmentHeaderV1Schema.safeParse({}).success).toBe(false);
    // A lazy schema can import successfully while a missing binding still throws
    // on its first real parse (the daemon startup regression).
    expect(DeploymentEnvironmentHeaderV1Schema.shape.dataAgentAccess.parse('readWriteAsk')).toBe('readWriteAsk');
    expect(DeploymentEnvironmentHeaderV1Schema.shape.dataAgentAccess.safeParse('invalid').success).toBe(false);
  });
});
