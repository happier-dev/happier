import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('daemon Agent runtime session bridge ownership', () => {
  it('does not compose ACP or construct the legacy host plugin context in the daemon', () => {
    const source = readFileSync(
      new URL('./sessionBridgeRoutes.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('createPublicAcpSession');
    expect(source).not.toContain('createHostPluginContextV1');
  });

  it('routes child interaction effects through the typed current-session owner', () => {
    const source = readFileSync(
      new URL(
        '../../agent/runtime/session/process/agentRuntimeDaemonBridgeClient.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const interactionCase = source.slice(
      source.indexOf("case 'session.interactions.request'"),
      source.indexOf("case 'session.systemRecords.read'"),
    );

    expect(interactionCase).toContain('HostCurrentSessionInteractionsService');
    expect(interactionCase).toContain('.interactions.request(');
    expect(interactionCase).not.toContain('Reflect.get');
  });

  it('routes native-child turn contributions through the private daemon bridge without a singleton fallback', () => {
    const lifecycleSource = readFileSync(
      new URL(
        '../../agent/runtime/session/loop/lifecycle.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const bridgeSelection = lifecycleSource.slice(
      lifecycleSource.indexOf('const daemonTurnContributionsBridge'),
      lifecycleSource.indexOf('transitionModelSelectionBeforePrompt'),
    );

    expect(bridgeSelection).toContain(
      'tryCreateDaemonAgentRuntimeTurnContributionsBridge()',
    );
    expect(bridgeSelection).toContain(
      'daemonTurnContributionsBridge.resolvePrompt',
    );
    expect(bridgeSelection).toMatch(
      /daemonTurnContributionsBridge\s*\.transformAgentContext/,
    );
    expect(bridgeSelection).toContain(
      "transformAgentContextErrorPolicy: daemonTurnContributionsBridge\n        ? 'throw'",
    );
    const promptBridgeBranch = bridgeSelection.slice(
      bridgeSelection.indexOf('? await daemonTurnContributionsBridge.resolvePrompt'),
      bridgeSelection.indexOf(': {\n              promptAssetBlocks:'),
    );
    const transformBridgeBranch = bridgeSelection.slice(
      bridgeSelection.indexOf('? async (payload) => await daemonTurnContributionsBridge'),
      bridgeSelection.indexOf(': transformAgentContextThroughPluginHooks'),
    );

    expect(promptBridgeBranch).not.toContain('catch');
    expect(transformBridgeBranch).not.toContain('catch');
  });

  it('reports packed runtime and current-source daemon-child evidence independently', () => {
    const source = readFileSync(
      new URL(
        '../../../../../packages/tests/scripts/plugin-platform/run-agent-runtime-conformance.mjs',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).toContain(
      'src/daemon/agentRuntime/sessionBridgeRoutes.real.integration.test.ts',
    );
    expect(source).toContain(
      'runs the real daemon route, child ACP composer, provider process, retirement, and restart',
    );
    expect(source).toContain(
      'runs the installed packed third-party native Agent through the real daemon-child bridge',
    );
    expect(source).toContain('sourceDaemonChildBridge:');
    expect(source).toContain("fixtureRelation: 'independent-from-packed-plugin'");
    expect(source).toContain('packedDaemonChildBridge:');
    expect(source).toContain("fixtureRelation: 'installed-packed-third-party'");
    expect(source).toContain("scope: 'composite-packed-process-foundation'");
    expect(source).toContain('daemonChildBridge: {');
    expect(source).toContain('hostRuntimeAndSupervisor: {');
    expect(source).toContain(
      "fixtureRelation: 'installed-packed-third-party-in-process-host'",
    );
    expect(source).not.toContain(
      'src/agent/runtime/session/process/agentRuntimeChildTransport.test.ts',
    );
  });
});
