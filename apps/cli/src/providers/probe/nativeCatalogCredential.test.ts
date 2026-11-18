import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentModelConfig } from '@happier-dev/agents';
import { readClaudeSettingSourcesV2 } from '@happier-dev/protocol/agents/claude/predecessor-message-meta';

import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { createPreflightCatalogCleanupScope } from '@/capabilities/probes/preflightCatalogCleanupScope';
import { logger } from '@/ui/logger';

import { isDynamicModelProbeEnabled, resolveNativeCatalogTarget } from './nativeCatalogCredential';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const observation = {
  providerLocalId: 'anthropic',
  purpose: 'model_upstream',
  connectedServiceId: 'claude-subscription',
  nativeTarget: { credentialSources: [{ kind: 'jsonFile', fileId: '.credentials.json',
    jsonPath: ['claudeAiOauth', 'accessToken'], defaultEndpointOnly: true,
    headers: [{ name: 'authorization', format: 'bearer' }] }] },
} as const;

describe('native catalog credentials', () => {

  async function helperFixture(script: string) {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-helper-'));
    roots.push(root);
    const helperPath = join(root, 'helper.cjs');
    const markerPath = join(root, 'helper-ran');
    await writeFile(helperPath, `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n${script}`);
    // Paths here are test-owned temporary paths, never untrusted shell input.
    const command = `"${process.execPath}" "${helperPath}"`;
    await writeFile(join(root, 'settings.json'), JSON.stringify({ apiKeyHelper: command }));
    await writeFile(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'other-account-login' } }));
    return {
      root,
      markerPath,
      catalogEntry: {
        getConnectedServiceStateSharingDescriptor: async () => ({
          providerId: 'claude', providerSupportStatus: 'supported' as const,
          config: { supported: true, modes: ['linked', 'copied', 'isolated'] as const,
            entries: [{ path: 'settings.json', mode: 'linked_or_copied' as const }] },
          state: { supported: true, modes: ['isolated', 'shared'] as const, entries: [],
            sharedStatePrivacyRiskAcknowledgementRequired: true, symlinkUnavailableDegradePolicy: 'block_continuity' as const },
          authIsolation: { mode: 'materialized_home' as const, secretEntries: ['.credentials.json'] },
          nativeHome: { environmentKey: 'CLAUDE_CONFIG_DIR', defaultRelativePath: '.claude' },
        }),
      },
    };
  }

  const helperObservation = {
    providerLocalId: 'anthropic', purpose: 'model_upstream', connectedServiceId: 'claude-subscription',
    nativeTarget: {
      endpointEnvironmentVariable: 'ANTHROPIC_BASE_URL',
      credentialSources: [
        { kind: 'environment', variable: 'ANTHROPIC_AUTH_TOKEN', headers: [{ name: 'authorization', format: 'bearer' }] },
        { kind: 'environment', variable: 'ANTHROPIC_API_KEY', headers: [{ name: 'x-api-key', format: 'raw' }] },
        { kind: 'jsonCommand', fileId: 'settings.json', jsonPath: ['apiKeyHelper'], requiredSettingSource: 'user', maxCredentialLength: 16_384,
          headers: [{ name: 'x-api-key', format: 'raw' }, { name: 'authorization', format: 'bearer' }] },
        { kind: 'environment', variable: 'CLAUDE_CODE_OAUTH_TOKEN', headers: [{ name: 'authorization', format: 'bearer' }] },
        { kind: 'jsonFile', fileId: '.credentials.json', jsonPath: ['claudeAiOauth', 'accessToken'], defaultEndpointOnly: true,
          headers: [{ name: 'authorization', format: 'bearer' }] },
      ],
    },
  } as const;

  it('resolves a user helper for the effective gateway before the saved login', async () => {
    const fixture = await helperFixture("process.stdout.write('gateway-key\\n');");
    const args = {
      observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com',
      environment: { CLAUDE_CONFIG_DIR: fixture.root, ANTHROPIC_BASE_URL: 'https://gateway.example/proxy/anthropic' },
      enabledSettingSources: readClaudeSettingSourcesV2({ claudeRemoteSettingSourcesV2: ['user', 'project'] }, {}),
    };
    await expect(resolveNativeCatalogTarget(args)).resolves.toMatchObject({
      status: 'ready', credentialValue: 'gateway-key',
      endpointUrl: expect.stringContaining('https://gateway.example/proxy/anthropic'),
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      headerBindings: [{ name: 'x-api-key', format: 'raw' }, { name: 'authorization', format: 'bearer' }],
    });
    await expect(access(fixture.markerPath)).resolves.toBeUndefined();
  });

  it('runs a user helper in the selected workspace directory', async () => {
    const fixture = await helperFixture("process.stdout.write(require('node:fs').readFileSync('selected-account-key', 'utf8'));");
    const cwd = join(fixture.root, 'selected-workspace');
    await mkdir(cwd);
    await writeFile(join(cwd, 'selected-account-key'), 'selected-workspace-account');
    await expect(resolveNativeCatalogTarget({
      observation: helperObservation, catalogEntry: fixture.catalogEntry, cwd,
      defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: ['user'],
      environment: { CLAUDE_CONFIG_DIR: fixture.root, CLAUDE_CODE_OAUTH_TOKEN: 'other-account' },
    })).resolves.toMatchObject({ status: 'ready', credentialValue: 'selected-workspace-account' });
  });

  it('makes a configured failing helper terminal even with another account available', async () => {
    const fixture = await helperFixture('process.exit(1);');
    const args = {
      observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com',
      environment: { CLAUDE_CONFIG_DIR: fixture.root, CLAUDE_CODE_OAUTH_TOKEN: 'other-account-env' },
      enabledSettingSources: ['user'],
    };
    await expect(resolveNativeCatalogTarget(args)).resolves.toMatchObject({ status: 'unavailable' });
    await expect(access(fixture.markerPath)).resolves.toBeUndefined();
  });

  it('skips invalid user settings and keeps normal setup or saved-login selection', async () => {
    const fixture = await helperFixture("process.stdout.write('must-not-run');");
    const args = { observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: ['user'],
      environment: { CLAUDE_CONFIG_DIR: fixture.root, CLAUDE_CODE_OAUTH_TOKEN: 'setup-login' } };
    for (const settings of ['{ invalid json', 'null', '[]', 'true', '{}', '{"apiKeyHelper":42}']) {
      await writeFile(join(fixture.root, 'settings.json'), settings);
      await expect(resolveNativeCatalogTarget(args)).resolves.toMatchObject({ status: 'ready', credentialValue: 'setup-login' });
      await expect(resolveNativeCatalogTarget({ ...args, environment: { CLAUDE_CONFIG_DIR: fixture.root } }))
        .resolves.toMatchObject({ status: 'ready', credentialValue: 'other-account-login' });
    }
    await expect(access(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not execute a helper excluded by the canonical legacy settings-source policy', async () => {
    const fixture = await helperFixture("process.stdout.write('must-not-run');");
    const args = {
      observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com',
      environment: { CLAUDE_CONFIG_DIR: fixture.root },
      enabledSettingSources: readClaudeSettingSourcesV2({ claudeRemoteSettingSourcesV2: ['user', 'project'] }, {
        claudeRemoteSettingSources: 'none',
      }),
    };
    await expect(resolveNativeCatalogTarget(args)).resolves.toMatchObject({ status: 'ready', credentialValue: 'other-account-login' });
    await expect(access(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses explicit credentials before running user helpers or selecting setup OAuth', async () => {
    const fixture = await helperFixture("process.stdout.write('must-not-run');");
    const target = await resolveNativeCatalogTarget({
      observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: ['user'],
      environment: { CLAUDE_CONFIG_DIR: fixture.root, ANTHROPIC_API_KEY: 'explicit-key', CLAUDE_CODE_OAUTH_TOKEN: 'setup' },
    });
    expect(target).toMatchObject({ status: 'ready', credentialValue: 'explicit-key',
      headerBindings: [{ name: 'x-api-key', format: 'raw' }] });
    await expect(access(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts the documented maximum token with outer whitespace and rejects excess token output', async () => {
    const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const fixture = await helperFixture("process.stdout.write(' '.repeat(100_000) + 'k'.repeat(16_384) + '\\r\\n');");
    const args = { observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: ['user'],
      environment: { CLAUDE_CONFIG_DIR: fixture.root, CLAUDE_CODE_OAUTH_TOKEN: 'setup' } };
    await expect(resolveNativeCatalogTarget(args)).resolves.toMatchObject({ status: 'ready', credentialValue: 'k'.repeat(16_384) });
    await writeFile(join(fixture.root, 'helper.cjs'), "process.stdout.write('k'.repeat(16_385));");
    await expect(resolveNativeCatalogTarget(args)).resolves.toMatchObject({ status: 'unavailable' });
    expect(warning).toHaveBeenCalledWith(expect.any(String), { phase: 'providers.catalog.native_helper_output' });
  });

  it('does not send a saved default-endpoint login to a custom gateway', async () => {
    const warning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const fixture = await helperFixture("process.stdout.write('must-not-run');");
    const args = { observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: [],
      environment: { CLAUDE_CONFIG_DIR: fixture.root, ANTHROPIC_BASE_URL: 'https://gateway.example/prefix' } };
    await expect(resolveNativeCatalogTarget(args)).resolves.toEqual({ status: 'absent' });
    await expect(resolveNativeCatalogTarget({ ...args, environment: { ...args.environment, ANTHROPIC_BASE_URL: 'invalid' } }))
      .resolves.toEqual({ status: 'unavailable' });
    expect(warning).toHaveBeenCalledWith(expect.any(String), { phase: 'providers.catalog.native_endpoint' });
    await expect(access(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an exhausted containing deadline before executing a helper', async () => {
    const fixture = await helperFixture("process.stdout.write('must-not-run');");
    await expect(resolveNativeCatalogTarget({ observation: helperObservation, catalogEntry: fixture.catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: ['user'],
      environment: { CLAUDE_CONFIG_DIR: fixture.root }, deadlineAtMs: Date.now() - 1,
    })).rejects.toMatchObject({ name: 'ProviderProbeCancelledError' });
    await expect(access(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a running helper through the containing request and process owner', async () => {
    const controller = new AbortController();
    const server = createServer((_request, response) => { response.end(); controller.abort(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const fixture = await helperFixture(`require('node:http').get('http://127.0.0.1:${address.port}', response => response.resume()); setTimeout(() => process.stdout.write('late-key'), 1000);`);
      await expect(resolveNativeCatalogTarget({ observation: helperObservation, catalogEntry: fixture.catalogEntry,
        defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: ['user'],
        environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLAUDE_CONFIG_DIR: fixture.root, CLAUDE_CODE_OAUTH_TOKEN: 'other-account' },
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'ProviderProbeCancelledError' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps the outer catalog scope until an aborted helper has terminated', async () => {
    const controller = new AbortController();
    const cleanupScope = createPreflightCatalogCleanupScope();
    let ready!: (pid: number) => void;
    const started = new Promise<number>(resolve => { ready = resolve; });
    const server = createServer((request, response) => { response.end(); ready(Number(request.url?.slice(1))); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    let helperSettlement: Promise<unknown> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const fixture = await helperFixture("process.on('SIGTERM', () => {}); require('node:http').get('http://127.0.0.1:" + address.port + "/' + process.pid, response => response.resume()); setInterval(() => {}, 1000);");
      const result = withAgentPreflightCatalog({ agentId: 'claude', signal: controller.signal, cleanupScope }, async () => {
        helperSettlement = resolveNativeCatalogTarget({
          observation: helperObservation, catalogEntry: fixture.catalogEntry,
          defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: ['user'],
          environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLAUDE_CONFIG_DIR: fixture.root },
          signal: controller.signal, retainCleanup: cleanupScope.retain,
        });
        return await helperSettlement;
      });
      const rejected = expect(result).rejects.toBeDefined();
      const pid = await started;
      controller.abort();
      await rejected;
      // The containing owner may release registry/artifact leases only after cleanup.
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await helperSettlement?.catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('reads only the declared native-home credential and returns an opaque fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-catalog-'));
    roots.push(root);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'native-oauth-token' },
    }));
    const catalogEntry = {
      getConnectedServiceStateSharingDescriptor: async () => ({
        providerId: 'claude',
        providerSupportStatus: 'supported' as const,
        config: { supported: true, modes: ['linked', 'copied', 'isolated'] as const, entries: [] },
        state: {
          supported: true,
          modes: ['isolated', 'shared'] as const,
          entries: [],
          sharedStatePrivacyRiskAcknowledgementRequired: true,
          symlinkUnavailableDegradePolicy: 'block_continuity' as const,
        },
        authIsolation: { mode: 'materialized_home' as const, secretEntries: ['.credentials.json'] },
        nativeHome: { environmentKey: 'CLAUDE_CONFIG_DIR', defaultRelativePath: '.claude' },
      }),
    };

    const result = await resolveNativeCatalogTarget({
      observation,
      catalogEntry,
      defaultEndpointUrl: 'https://api.anthropic.com', enabledSettingSources: [],
      environment: { CLAUDE_CONFIG_DIR: join(root, '.claude') },
    });

    expect(result).toEqual({
      status: 'ready', endpointUrl: 'https://api.anthropic.com/',
      headerBindings: [{ name: 'authorization', format: 'bearer' }],
      credentialValue: 'native-oauth-token',
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it('lets either the account setting or environment kill switch disable probing', () => {
    const modelConfig = {
      dynamicProbe: 'auto',
      dynamicProbeControl: {
        accountSettingId: 'claudeDynamicModelProbeEnabled',
        environmentVariable: 'HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED',
      },
    } as AgentModelConfig;

    expect(isDynamicModelProbeEnabled({ modelConfig, accountSettings: null, environment: {} })).toBe(true);
    expect(isDynamicModelProbeEnabled({
      modelConfig,
      accountSettings: { claudeDynamicModelProbeEnabled: false },
      environment: {},
    })).toBe(false);
    expect(isDynamicModelProbeEnabled({
      modelConfig,
      accountSettings: { claudeDynamicModelProbeEnabled: true },
      environment: { HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED: '0' },
    })).toBe(false);
  });
});
