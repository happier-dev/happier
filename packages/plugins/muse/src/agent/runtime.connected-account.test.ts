import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { invokeCliPreflightMethod } from '@/capabilities/probes/agentPreflight';
import { createMuseForegroundConnectedAccountFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.codexConnectedServices.testkit';
import { withRealForegroundAdmissionFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording, readMuseMspProcessAudit } from './testkit/mspProcess.js';

afterEach(() => vi.restoreAllMocks());

it('selects the same qualified Muse Account independently for model demand and foreground native launch', async () => {
  const account = await createMuseForegroundConnectedAccountFixture(['work', 'personal']);
  const overrideKey = resolveAgentCliOverrideEnvKey('muse');
  const env = createEnvKeyScope(['PATH', 'META_API_KEY', overrideKey]);
  try {
    // The selected qualified work binding and a distinct personal credential
    // discriminate Account selection from the conflicting ambient key.
    await withRealForegroundAdmissionFixture({ runtimeOptions: account.runtimeOptions }, async foreground => {
      const credentialAudit = join(foreground.directory, 'credential-equality.jsonl');
      const catalogAudit = join(foreground.directory, 'catalog-audit.json');
      const nativeScript = join(foreground.directory, 'muse-account-playback.cjs');
      const recording = await readMuseLoginRecording();
      await writeFile(nativeScript, [
        "const fs = require('node:fs');",
        "if (process.argv.includes('--version')) { console.log('1.4.14'); process.exit(0); }",
        // Only booleans cross this test evidence boundary; no credential bytes
        // are written by the native process or included in assertion output.
        `fs.appendFileSync(${JSON.stringify(credentialAudit)}, JSON.stringify({ selectedCredentialMatches: process.env.META_API_KEY === 'synthetic-selected-muse-key', ambientCredentialUsed: process.env.META_API_KEY === 'synthetic-ambient-muse-key' }) + '\\n');`,
        `process.env.MUSE_TEST_RECORDING ??= ${JSON.stringify(JSON.stringify(recording))};`,
        `process.env.MUSE_TEST_AUDIT_PATH ??= ${JSON.stringify(catalogAudit)};`,
        MUSE_MSP_PLAYBACK_SCRIPT,
      ].join('\n'));
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const executable = writeExecutableShimSync({ dir: foreground.directory,
        fileName: process.platform === 'win32' ? 'muse.cmd' : 'muse',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${nativeScript}" %*\r\n`
          : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeScript)} "$@"\n`,
      });
      const path = `${foreground.directory}${delimiter}${process.env.PATH ?? ''}`;
      env.patch({ PATH: path, META_API_KEY: 'synthetic-ambient-muse-key', [overrideKey]: executable });
      const dependencies = await account.dependenciesFor(foreground.runtime.registry, foreground.directory);
      const registry = foreground.runtime.registry;
      const entry = registry.contributes.agentDefinitionsById.get('muse')?.catalogEntry;
      if (!entry) throw new Error('Expected actual admitted Muse model frontdoor');
      const models = await invokeCliPreflightMethod('muse', 'probeModels', {
        cwd: foreground.directory, bypassCache: true, connectedServices: account.connectedServices,
        environmentVariables: { PATH: path },
      }, {
        agentCatalogEntry: entry, agentRegistrySnapshot: registry.contributes,
        accountContext: { credentials: account.credentials, accountSettings: null },
        createApiClient: async () => account.api,
        connectedAccountsOwner: account.owner, activatePurposeBindings: account.owner.activatePurposeBindings,
        isAgentRegistryCurrent: () => foreground.runtime.controller.isRuntimeRegistryCurrent(registry),
        createAgentInvocationServices: registry.createAgentInvocationServices,
        agentRuntimeCacheKey: registry.readPluginOccurrenceId('happier.agent.muse'),
      }, {});
      expect(models).toMatchObject({ ok: true });
      const catalog = await readMuseMspProcessAudit(catalogAudit);
      expect(catalog.methods).toEqual(['initialize', 'initialized', 'model/list']);
      expect(catalog).toMatchObject({ initializeCount: 1, initializedCount: 1, commandCount: 0,
        autoUpdate: '1', cwd: foreground.directory });
      const readEquality = async () => (await readFile(credentialAudit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(await readEquality()).toEqual([{ selectedCredentialMatches: true, ambientCredentialUsed: false }]);

      // This admission independently acquires its own materialization. The
      // model probe's prepared environment is never fed into launch.
      const admission = await foreground.prepare({ agentId: 'muse',
        backendTarget: { kind: 'backend', backendId: 'muse', sourceKind: 'built_in' },
      }, dependencies);
      if (!admission.ok) throw new Error(`Foreground Account admission refused: ${admission.error.code}`);
      const claimed = await admission.prepared.claim({ canonicalSessionId: 'muse-selected-account', httpPort: 40123,
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
      expect(claimed).toMatchObject({ ok: true });
      if (!claimed.ok) throw new Error(claimed.error.code);
      expect(claimed.sessionConnectedAccounts).toContainEqual(expect.objectContaining({ purpose: 'muse-native',
        account: { service: account.service, accountId: 'work' } }));
      const session = await createAdmittedMuseSessionFixture({ admittedRuntime: foreground.runtime,
        cwd: foreground.directory, sessionId: 'muse-selected-account', nativeExecutable: executable,
        environment: { PATH: path, ...claimed.environment },
      });
      try {
        await session.open({ kind: 'create', sessionId: 'muse-selected-account', cwd: foreground.directory,
          launchEnvironment: { values: claimed.environment, unset: claimed.unsetEnvironmentVariableNames },
          connectedAccounts: claimed.sessionConnectedAccounts,
        });
        await session.closeSession();
        const launch = await session.readAudit();
        expect(launch.methods.filter(method => method === 'session/start')).toHaveLength(1);
        expect(launch.methods).not.toContain('model/list');
        expect(launch.methods).not.toContain('turn/start');
        expect(launch).toMatchObject({ initializeCount: 1, initializedCount: 1, cwd: foreground.directory, autoUpdate: '1' });
        expect(await readEquality()).toEqual([
          { selectedCredentialMatches: true, ambientCredentialUsed: false },
          { selectedCredentialMatches: true, ambientCredentialUsed: false },
        ]);
      } finally { await session.dispose(); }
    });
  } finally {
    env.restore();
    await account.cleanup();
  }
});
