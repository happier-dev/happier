import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { SessionHostBridge } from './SessionHostBridge';
import { PLUGIN_MANIFEST as museManifest } from '../../../../../../../packages/plugins/muse/src/manifest';
import { PLUGIN_MANIFEST as geminiManifest } from '../../../../../../../packages/plugins/gemini/src/manifest';
import { PLUGIN_MANIFEST as codexManifest } from '../../../../../../../packages/plugins/codex/src/manifest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { createRunnerAgentSessionBootstrapAuthorization } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { configuration } from '@/configuration';

it('names the missing Muse bootstrap in its content-free startup cause', async () => {
  await expect(runAddedHostedSession({ environment: {}, workingDirectory: process.cwd(), end: () => {} },
    () => new SessionHostBridge().createSessionRuntime('muse', {
      directory: process.cwd(), happyHomeDir: process.cwd(), startedBy: 'daemon',
      credentials: { token: 'fixture-runner', encryption: null },
    }))).rejects.toMatchObject({ code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING', failureCause: {
      code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING', phase: 'client_start', failureReason: 'unknown',
    } });
});

it.each([codexManifest, geminiManifest, museManifest])('resolves $id from its hosted Session environment', async manifest => {
  const home = await mkdtemp(join(tmpdir(), 'happier-hosted-bootstrap-'));
  try {
    // Real private-file admission and engine resolution; no bearer or Agent
    // executable is needed until the returned plan opens its runtime.
    const definition = PluginAgentContributionV2Schema.parse(manifest.contributes.agents?.[0]);
    const bootstrap = await createRunnerAgentSessionBootstrapAuthorization({
      happyHomeDir: home, publicReleaseRing: configuration.publicReleaseRing, descriptor: {
      v: 1, pluginId: manifest.id, pluginVersion: manifest.version,
      agentId: definition.id, backendId: definition.id, occurrenceId: 'hosted-bootstrap',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'hosted-generation', installSource: 'localPath' },
      agentDeclaration: { provenance: 'first_party', source: { kind: 'bundled' }, definition },
    } });
    const environment = { ...process.env,
      HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE: bootstrap.authorization.bootstrapFilePath,
      HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE: join(home, 'authority-not-yet-claimed.json'),
    };
    const plan = await runAddedHostedSession({ environment, workingDirectory: home,
      end: () => { throw new Error('Planning must not terminate the Session'); } },
    () => new SessionHostBridge().createSessionRuntime(definition.id, {
      directory: home, happyHomeDir: home, startedBy: 'daemon',
      credentials: { token: 'fixture-runner', encryption: null },
    }));
    expect(plan.kind).toBe('hostSessionRuntimePlan');
    expect(plan.agentId).toBe(definition.id);
    expect(plan.config.createSessionRuntime).toBeTypeOf('function');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);
