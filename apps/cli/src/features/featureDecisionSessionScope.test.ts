import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { bindHostedSessionId, readHostedSessionScope, runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerExecutionRunRpcHandlers } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createSessionMcpToolInventory } from '@/mcp/server/sessionMcpToolInventory';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import {
  createMcpActionEnablementWithServerFeatureAvailability,
  createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';
import { resolveSessionDetailAccessProjectionVersion } from '@/session/transport/http/sessionsHttp';
import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from './featureDecisionService';

afterEach(() => vi.unstubAllEnvs());

describe('hosted Session feature policy', () => {
  const serverSnapshot: CliServerFeaturesSnapshot = {
    status: 'ready',
    provenance: 'authenticated',
    features: FeaturesResponseSchema.parse({ features: {
      sessions: { enabled: true, board: { enabled: true } },
      sharing: { session: { enabled: true } },
    }, capabilities: {} }),
  };

  it('keeps MCP availability and Session detail projection isolated across concurrent Sessions', async () => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const readSessionFeatures = (environment: NodeJS.ProcessEnv) => runAddedHostedSession({
      environment, workingDirectory: '/session', end: () => {},
    }, async () => {
      await Promise.resolve();
      const isEnabled = createMcpActionEnablementWithServerFeatureAvailability({
        actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
        surface: 'agent', hasAuthenticatedRuntime: true,
        readServerFeaturesSnapshot: () => serverSnapshot,
      });
      return {
        board: isEnabled('session.board.layout.update'),
        projection: resolveSessionDetailAccessProjectionVersion({ serverFeaturesSnapshot: serverSnapshot }),
      };
    });

    expect(await Promise.all([
      readSessionFeatures({ HAPPIER_BUILD_FEATURES_DENY: 'sessions.board,sharing.session' }),
      readSessionFeatures({}),
    ])).toEqual([{ board: false, projection: undefined }, { board: true, projection: 1 }]);
  });

  it('uses each Session local policy while preserving explicit environments and standalone defaults', async () => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    const readSessionFeatures = (enabled: string) => runAddedHostedSession({
      environment: { HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: enabled },
      workingDirectory: '/session', end: () => {},
    }, async () => {
      await Promise.resolve();
      return {
        scoped: resolveCliFeatureDecision({ featureId: 'execution.runs' }).state,
        explicit: resolveCliFeatureDecision({ featureId: 'execution.runs', env: {} }).state,
        descriptor: executionRunsCapability.descriptor.protocol,
      };
    });

    expect(await Promise.all([readSessionFeatures('0'), readSessionFeatures('1')])).toMatchObject([
      { scoped: 'disabled', explicit: 'enabled', descriptor: { available: false } },
      { scoped: 'enabled', explicit: 'enabled', descriptor: { available: true } },
    ]);
    expect(resolveCliFeatureDecision({ featureId: 'execution.runs' }).state).toBe('enabled');
  });

  it('retains Session feature policy and the original scope for RPC callbacks dispatched outside that scope', async () => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    const register = (enabled: string) => runAddedHostedSession({
      environment: { HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: enabled },
      workingDirectory: `/session-${enabled}`, end: () => {},
    }, () => {
      const sessionId = `session-${enabled}`;
      bindHostedSessionId(sessionId);
      const scope = readHostedSessionScope();
      const rpc = new RpcHandlerManager({ scopePrefix: sessionId, scopeKind: 'session', encryptionMode: 'plain', logger: () => {} });
      const registration = registerExecutionRunRpcHandlers(rpc, {
        sessionId, cwd: `/session-${enabled}`, parentProvider: 'codex', sendAcp: () => {},
      });
      onTestFinished(() => registration.dispose());
      rpc.registerHandler('hostedScopeProbe', () => readHostedSessionScope() === scope);
      return async () => ({
        feature: await rpc.handleRequest({ method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2}`,
          params: {}, callerAuthority: 'present_user' }),
        originalScope: await rpc.handleRequest({ method: `${sessionId}:hostedScopeProbe`, params: {} }),
      });
    });
    const disabled = register('0');
    const enabled = register('1');
    expect(readHostedSessionScope()).toBeUndefined();
    expect(await Promise.all([disabled(), enabled()])).toMatchObject([
      { feature: { errorCode: 'execution_run_not_allowed' }, originalScope: true },
      { feature: { errorCode: 'execution_run_invalid_action_input' }, originalScope: true },
    ]);
  });

  it('retains MCP feature environments for callbacks outside their hosted Session and honors explicit env', () => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const register = (deny: string, env?: NodeJS.ProcessEnv) => runAddedHostedSession({
      environment: { HAPPIER_BUILD_FEATURES_DENY: deny }, workingDirectory: '/session', end: () => {},
    }, () => createMcpActionEnablementWithServerFeatureAvailability({
      actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
      surface: 'agent', hasAuthenticatedRuntime: true, readServerFeaturesSnapshot: () => serverSnapshot,
      ...(env ? { env } : {}),
    }));
    const disabled = register('sessions.board');
    const enabled = register('');
    const explicit = register('sessions.board', {});
    expect(readHostedSessionScope()).toBeUndefined();
    expect([disabled('session.board.layout.update'), enabled('session.board.layout.update'), explicit('session.board.layout.update')])
      .toEqual([false, true, true]);
    const registerInventory = (deny: string) => runAddedHostedSession({
      environment: { HAPPIER_BUILD_FEATURES_DENY: deny }, workingDirectory: '/session', end: () => {},
    }, () => createSessionMcpToolInventory({
      client: createMutableApiSessionClientFixture({ sessionId: `inventory-${deny || 'enabled'}`,
        overrides: { getServerFeaturesSnapshot: () => serverSnapshot } }),
      happierToolsEnabled: true, hasAuthenticatedRuntime: true,
      actionSettingsProvider: { getActionsSettings: () => ({ v: 1, actions: {
        'session.board.layout.update': { toolExposureModes: { agent: 'direct' } },
      } }) },
    }));
    const deniedInventory = registerInventory('sessions.board');
    const enabledInventory = registerInventory('');
    onTestFinished(() => { deniedInventory.dispose(); enabledInventory.dispose(); });
    const exposesBoardUpdate = (inventory: ReturnType<typeof registerInventory>) =>
      [...inventory([]).actionToolNameToId.values()].includes('session.board.layout.update');
    expect([exposesBoardUpdate(deniedInventory), exposesBoardUpdate(enabledInventory)]).toEqual([false, true]);
  });
});
