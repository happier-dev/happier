import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { createFxAgentRuntime } from '../../../../../../packages/plugins/fx/src/agent/runtime/factory.js';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { FX_PLUGIN } from '../../../../../../packages/plugins/fx/src/manifest.js';
import { FX_TERMINAL_CONTRIBUTION } from '../../../../../../packages/plugins/fx/src/agent/terminal/contribution.js';
import { openAiConnectedAccountRuntime } from '../../../../../../packages/plugins/openai/src/auth/connectedAccountRuntime.js';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  const assets = Object.fromEntries(await Promise.all((FX_PLUGIN.manifest.contributes.resources ?? []).flatMap(resource =>
    resource.kind === 'asset' ? [readFile(join(import.meta.dirname, '../../../../../../packages/plugins/fx', resource.path)).then(contents => [resource.path, contents] as const)] : [])));
  runtime = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    plugins: [{ manifest: FX_PLUGIN.manifest, replaceExisting: true,
      files: { '.happier-plugin/daemon.js': 'export function activate() {}',
        // Admission resolves the registered runner locator even though this test
        // supplies the real imported callback module at the loading boundary.
        '.happier-plugin/agent/runtime/factory.js': 'export function createFxAgentRuntime() {}', ...assets },
      // The public registration is real; physical plugin loading is the fixture boundary.
      instantiateCommittedModule: () => FX_PLUGIN,
    }],
  });
});
afterAll(async () => { await runtime?.dispose(); });

it('prepares a private FX HOME for a selected environment-only key before native settings writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fx-selected-key-home-'));
  let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
  let lease: { dispose(): void } | undefined;
  let childFixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
  let session: AgentSessionRuntime | undefined;
  try {
    const nativeHome = join(root, 'personal');
    await mkdir(join(nativeHome, '.fx'), { recursive: true });
    const original = JSON.stringify({ provider: 'gateway', credential_source: 'vercel_oidc', theme: 'retained' });
    await writeFile(join(nativeHome, '.fx/settings.json'), original);
    const admittedAgent = runtime.registry.contributes.agents.find(agent =>
      agent.identity?.pluginId === FX_PLUGIN.manifest.id && agent.identity.localId === 'fx');
    if (!admittedAgent) throw new Error('The authored FX Agent was not admitted');
    const agentId = admittedAgent.id;
    const catalogEntry = await runtime.registry.acquireAgentCatalogEntry!(agentId);
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId, contributions: runtime.registry.contributes, catalogEntry,
    });
    if (!declaration) throw new Error('The admitted FX Agent has no Connected Account purpose declaration');
    const scope = declaration.authorizedPurposes.find(scope => scope.purpose.purpose === 'openai-api-key');
    if (!scope) throw new Error('FX source registration did not expose its selected key purpose');
    const context = { signal: new AbortController().signal, services: {}, configuration: { values: {} },
      credentials: { get: async (key: string) => key === 'token' ? 'fake-selected-key' : null },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const fixture = createForegroundPurposeOwnerFixture({ consumer: scope.purpose.consumer, purpose: scope.purpose.purpose,
      service: scope.serviceRefs[0]!, materializeAccount: async ({ request }) => openAiConnectedAccountRuntime.materialize(request, context),
    });
    lease = fixture.owner.activateSessionPurposeBindings({ sessionId: 'fx-selected-key', purposes: declaration.purposes, bindings: [fixture.binding] });
    result = await materializeConnectedServicesForSpawn({ agentId, materializationKey: 'fx-selected-key', purposeBindingSessionId: 'fx-selected-key',
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      connectedAccountsOwner: fixture.owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] }, processEnv: { HOME: nativeHome },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'copied', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {} } },
    });
    expect(result?.env.HOME).toEqual(expect.any(String));
    expect(result?.env.HOME).not.toBe(nativeHome);
    if (!result?.env.HOME) throw new Error('FX launch has no host-prepared HOME');
    await FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'fx-selected-key', cwd: root, metadata: {}, modelSelection: null,
      configuration: { model: { value: 'selected-model', updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 }, permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {} },
      launchEnvironment: { values: result.env, unset: result.unsetEnvKeys },
    });
    expect(await readFile(join(nativeHome, '.fx/settings.json'), 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(join(result.env.HOME, '.fx/settings.json'), 'utf8'))).toMatchObject({ provider: 'happier', models: { happier: 'selected-model' }, theme: 'retained' });
    const selectedEnvironment = result.env;
    const parsed = parsePluginManifest(FX_PLUGIN.manifest);
    if (!parsed.ok) throw new Error('Invalid FX source declaration');
    const agent = parsed.manifest.contributes.agents?.find(agent => agent.id === 'fx');
    if (!agent) throw new Error('Missing FX source Agent');
    childFixture = createAcpMcpPolicyFixture({ agent, pluginId: FX_PLUGIN.manifest.id,
      models: { currentModelId: 'selected-model', availableModels: [{ modelId: 'selected-model', name: 'Selected model' }] },
      async factory(context) {
        const native = await createFxAgentRuntime(context);
        if (!native.sessions) throw new Error('Missing FX Session runtime');
        const sessions = native.sessions;
        return { ...native, sessions: { ...sessions, open(request, host) {
          return sessions.open({ ...request, launchEnvironment: {
            values: { ...request.launchEnvironment?.values, ...selectedEnvironment, AI_GATEWAY_API_KEY: 'ambient' },
            unset: request.launchEnvironment?.unset ?? [],
          } }, host);
        } } };
      },
    });
    await childFixture.fixtureServer.prepare({ cwd: root });
    session = await childFixture.openSession({ kind: 'create', sessionId: 'fx-native-child', cwd: root,
      configuration: { model: { value: 'selected-model', updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {} },
    });
    const child = childFixture.observeLaunch();
    expect(child.env).toMatchObject({ HOME: selectedEnvironment.HOME, FX_PROVIDER: 'happier', FX_MODEL: 'selected-model',
      HAPPIER_FX_PROVIDER_API_KEY: 'fake-selected-key' });
    expect(child.env.AI_GATEWAY_API_KEY).toBeUndefined();
  } finally {
    try { await session?.dispose(); } finally {
      try { await childFixture?.fixtureServer.dispose(); } finally {
        await result?.cleanupOnExit?.();
        lease?.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
