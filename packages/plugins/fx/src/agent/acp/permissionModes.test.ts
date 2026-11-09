import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import { createPublicAcpExecutionRun, createPublicAcpSession, type PublicAcpComposerDependencies } from '../../../../../../apps/cli/src/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createNativeAgentSessionPublications } from '../../../../../../apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { writeAcpTestAgentScript } from '../../../../../../apps/cli/src/agent/acp/testkit/subprocessHarness';
import { createAcpSessionRuntimeContextFixture } from '../../../../../../apps/cli/src/agent/acp/testkit/runtimeContextFixture';
import { withTempDir } from '../../../../../../apps/cli/src/testkit/fs/tempDir';

import { createFxAgentRuntime } from '../runtime/factory.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

// Provenance: FX 0.0.14 build 1a070af32cdf, native session/new captured
// 2026-10-27 in .project/tmp/vercel-meeting/E-fx-live-probe.md §2.4–5 / §3.
// FX 0.0.13's `code` identity is pinned in C2-fx-acp-sol.md H1.
const MODES = {
  current: { currentModeId: 'auto', availableModes: [
    { id: 'auto', name: 'Auto', description: 'Check actions with an automatic safety review instead of asking' },
    { id: 'ask', name: 'Ask', description: 'Request permission before making any changes' },
    { id: 'full-access', name: 'Full access', description: 'Run every action without asking, outside the sandbox' },
  ] },
  legacy: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }, { id: 'ask', name: 'Ask' }] },
  unmatched: { currentModeId: 'full-access', availableModes: [{ id: 'full-access', name: 'Full access' }] },
} as const;

describe('FX permission presets through host ACP configuration', () => {
  it.each([
    ['current', 'safe-yolo', 'auto'],
    ['legacy', 'safe-yolo', 'code'],
    ['current', 'read-only', 'ask'],
    ['unmatched', 'read-only', null],
    ['unmatched', 'safe-yolo', null],
    ['absent', 'safe-yolo', null],
  ] as const)('applies %s Session modes to %s', async (version, permissionIntent, expectedMode) => {
    await withTempDir('happier-fx-permission-', async dir => {
      const modePath = join(dir, 'applied-mode.json');
      const scriptPath = writeAcpTestAgentScript({ dir, fileName: 'fx-permission-agent.mjs', source: `
        import { writeFileSync } from 'node:fs';
        writeFileSync(process.env.FX_TEST_APPLIED_MODE, 'null');
        let buffer = '';
        const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            if (request.method === 'initialize') reply(request.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
            else if (request.method === 'session/new') reply(request.id, { sessionId: 'native-fx',
              ...JSON.parse(process.env.FX_TEST_SESSION_MODES) });
            else if (request.method === 'session/set_mode') {
              writeFileSync(process.env.FX_TEST_APPLIED_MODE, JSON.stringify(request.params.modeId));
              reply(request.id, null);
            } else if (request.id !== undefined) reply(request.id, {});
          }
        });
      ` });
      const signal = new AbortController().signal;
      const publications = createNativeAgentSessionPublications({
        agentId: 'fx', session: null, signal, isCurrent: () => true, supportsInFlightSteer: false,
      });
      const dependencies = {
        pluginId: 'happier.agent.fx', agentId: 'fx', signal, isCurrent: () => true,
        modes: publications.services.modes, models: publications.services.models,
        interactions: { async request() { throw new Error('Unexpected host approval'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected media registration'); } },
        systemTools: { async resolve() { return { toolId: 'fx-cli', launch: {
          kind: 'binary', executablePath: process.execPath, args: [scriptPath],
          env: { FX_TEST_SESSION_MODES: JSON.stringify(version === 'absent' ? {} : { modes: MODES[version] }),
            FX_TEST_APPLIED_MODE: modePath },
        } }; } },
      } satisfies PublicAcpComposerDependencies;
      const factory = await createFxAgentRuntime({
        plugin: { id: 'happier.agent.fx', version: '0.0.0' }, agent: { id: 'fx' }, signal,
      });
      if (!factory.sessions) throw new Error('Expected the FX Session factory');
      const contextFixture = createAcpSessionRuntimeContextFixture({
        agent: PluginAgentContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.agents[0]),
        pluginId: 'happier.agent.fx', sessionId: 'host-fx', directory: dir, signal, publications,
        protocols: { acp: {
          open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) => (
            createPublicAcpSession(request, options, dependencies)
          ),
          openExecutionRunV1: (request: Parameters<typeof createPublicAcpExecutionRun>[0], options: AgentAcpRuntimeOptions) => (
            createPublicAcpExecutionRun(request, options, dependencies)
          ),
        } },
      });
      const opening = Promise.resolve(factory.sessions.open({ kind: 'create', sessionId: 'host-fx', cwd: dir,
        configuration: {
          mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: permissionIntent, updatedAtMs: 1 }, options: {},
        },
      }, contextFixture.context));
      try {
        if (expectedMode === null) {
          const failure = await opening.then(async session => {
            await session.dispose();
            return null;
          }, (error: unknown) => error);
          expect(failure).toMatchObject({ code: 'acp_permission_intent_unsupported' });
          expect(JSON.parse(readFileSync(modePath, 'utf8'))).toBeNull();
        } else {
          const session = await opening;
          try { expect(JSON.parse(readFileSync(modePath, 'utf8'))).toBe(expectedMode); }
          finally { await session.dispose(); }
        }
      } finally { await contextFixture.dispose(); }
    });
  });
});
