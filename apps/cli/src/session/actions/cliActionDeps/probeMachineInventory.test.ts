import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { CapabilitiesInvokeRequest, CapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { CODEX_PREFLIGHT_SESSION_CONTROLS } from '@happier-dev/plugins-codex/agent/lifecycle/preflight/sessionControls';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCapabilitiesService } from '@/capabilities/service';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import { CapabilityError } from '@/capabilities/errors';
import { handleActionsCommand } from '@/cli/commands/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe('native inventory failure through capability RPC and the CLI Action', () => {
  it.each([
    { kind: 'native', code: 'codex_legacy_mcp_backend_mode_unsupported', transport: 'local' },
    { kind: 'native', code: 'codex_legacy_mcp_backend_mode_unsupported', transport: 'plain' },
    { kind: 'provider', code: 'provider_endpoint_unauthorized', transport: 'local' },
    { kind: 'preflight', code: 'connected-service-preflight-failed', transport: 'local' },
    { kind: 'untyped', code: 'invoke-failed', transport: 'local' },
    { kind: 'malformed', code: 'invoke-failed', transport: 'local' },
  ] as const)('preserves the $kind failure through $transport RPC without private prose or automatic re-probes', async ({ kind, code, transport }) => {
    let nativeStarts = 0;
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected native boundary'); };
    const context: AgentPreflightSessionControlsProbeContextV1 = {
      cwd: process.cwd(), accountSettings: null, environment: {}, signal: new AbortController().signal,
      ...(kind === 'native' ? { runtimeKindOverride: 'mcp' } : {}),
      runDeclaredSystemToolCommand: unavailable,
      probeDeclaredAcpCatalogs: unavailable,
      resolveDeclaredSystemTool: unavailable,
      withDeclaredManagedService: unavailable,
      // The native process/JSON-RPC acquisition is the only replaced provider boundary.
      withDeclaredJsonRpcClient: async () => {
        nativeStarts += 1;
        if (kind === 'provider') throw new PluginError({ code, message: 'never-log-private-provider', retryable: false });
        if (kind === 'preflight') throw new CapabilityError('never-log-private-preflight', code);
        if (kind === 'malformed') throw Object.assign(new Error('never-log-private-native'), { code: 'never-log-private /credential' });
        throw new Error('never-log-private-native');
      },
    };
    const service = createCapabilitiesService({ capabilities: [{
      descriptor: { id: 'cli.codex', kind: 'cli', methods: { probeModels: {} } },
      effects: { detect: [], invoke: { probeModels: [] } },
      detect: async () => ({}),
      invoke: async () => ({ ok: true, result: await CODEX_PREFLIGHT_SESSION_CONTROLS.probeModels(context) }),
    }], checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
      buildContext: async () => ({ cliSnapshot: null }) });
    const completion = vi.fn();
    const rpc = new RpcHandlerManager({ scopePrefix: 'worker', encryptionMode: 'plain', logger: completion });
    const responses: unknown[] = [];
    rpc.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>(RPC_METHODS.CAPABILITIES_INVOKE, async input => {
      const response = await service.invoke(input);
      responses.push(response);
      return response;
    });
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      // Replace only the Machine transport hop; both dispatchers and all domain logic are real.
      callMachineAction: async input => transport === 'local' ? rpc.invokeLocal(input.method, input.request)
        : rpc.handleRequest({ method: `worker:${input.method}`, params: input.request }),
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    await handleActionsCommand(['invoke', 'agents.models.list', '--input-json', JSON.stringify({
      agentId: 'codex', machineId: 'worker', probe: { cwd: process.cwd() },
    }), '--json'], {
      readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null, credentialProvenance: 'api_token' }),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: unavailable }),
    });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ ok: false, kind: 'actions_invoke', error: { code, message: code,
      ...(kind === 'provider' ? { details: { retryable: false } } : {}),
    } });
    expect(responses).toEqual([{ ok: false, error: { code, message: code,
      ...(kind === 'provider' ? { retryable: false } : {}),
    } }]);
    expect(completion.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
      method: RPC_METHODS.CAPABILITIES_INVOKE, outcomeCode: code,
    })]]);
    expect(nativeStarts).toBe(kind === 'native' ? 0 : 1);
    expect(JSON.stringify({ output, responses, logs: completion.mock.calls })).not.toContain('never-log');
  });
});
