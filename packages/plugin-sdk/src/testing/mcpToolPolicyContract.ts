import { strict as assert } from 'node:assert';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { projectMcpToolLaunchPolicyV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import { AgentSessionConfigurationSnapshotV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentContribution } from '../agents.js';
import type {
    AgentPermissionIntent, AgentSessionConfigurationSnapshot, AgentSessionMcpLaunchConfig,
    AgentSessionMcpToolPolicy, AgentSessionOpenRequest, AgentSessionRuntime,
} from '../agentRuntime/session.js';
import type { ObservedAgentLaunch } from './observeAgentLaunch.js';

export type AgentMcpToolPolicyControl = Readonly<{ off: 'hidden' | 'blocked'; approval: 'native' | 'host' }>;
export type AgentMcpToolPolicySetting = 'off' | 'ask' | 'allow';
export type AgentMcpToolPolicyFixture = Readonly<{
    servers: readonly [
        Readonly<{ key: string; serverId: string; title: string; tool: string; config: AgentSessionMcpLaunchConfig }>,
        Readonly<{ key: string; serverId: string; title: string; tool: string; config: AgentSessionMcpLaunchConfig }>,
    ];
    secrets: readonly string[];
    /** Materializer-owned private files; these are never native Agent configuration. */
    privateConfigFiles?: readonly string[];
}>;
export type AgentMcpToolPolicyPermissionObservation = Readonly<{
    server: string; serverId: string; tool: string;
    decision: 'approved' | 'denied'; prompted: boolean;
    /** Shared monotonic observation order, assigned at actual host entry and server receipt. */
    order: number;
}>;
export type AgentMcpToolPolicyCallObservation = Readonly<{
    server: string; tool: string; order: number;
}>;
export type AgentMcpToolPolicyInvocation = Readonly<{
    outcome: 'completed' | 'denied' | 'hidden';
    /** Actual host-handler observations for this invocation; never synthesized requests. */
    permissions: readonly AgentMcpToolPolicyPermissionObservation[];
}>;
export type AgentMcpToolPolicyNativeObservation = Readonly<{
    /** Parsed from the actual native knob, not from the requested policy. */
    policy: Readonly<Record<string, AgentSessionMcpToolPolicy>>;
    /** Concrete native key/value evidence from the observed argv, environment, file or request. */
    artifacts: readonly Readonly<{ source: 'argv' | 'env' | 'file' | 'request'; key: string; value: string }>[];
}>;
export type AgentMcpToolPolicyContractInput = Readonly<{
    agent: AgentContribution;
    openSession: (request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>;
    /** Record full effective argv/environment at the actual spawned process, including inheritance. */
    observeLaunch: () => ObservedAgentLaunch;
    invokeTool: (runtime: AgentSessionRuntime, request: Readonly<{
        server: string; tool: string; arguments: Readonly<Record<string, unknown>>;
        approvalScope: 'once' | 'session';
    }>) => Promise<AgentMcpToolPolicyInvocation>;
    fixtureServer: Readonly<{
        prepare(input: Readonly<{ cwd: string }>): Promise<AgentMcpToolPolicyFixture>;
        observeCalls(): readonly AgentMcpToolPolicyCallObservation[];
        /** Change the live catalog through its canonical producer; native changes consume the
         * existing configuration-update carrier. The projection alone is not host policy. */
        setPolicy(input: Readonly<{
            runtime?: AgentSessionRuntime; permissionMode: AgentPermissionIntent;
            settings: Readonly<Record<string, AgentMcpToolPolicySetting>>;
            projection: Readonly<Record<string, AgentSessionMcpToolPolicy>>;
            configuration: AgentSessionConfigurationSnapshot;
        }>): Promise<void>;
        dispose(): Promise<void>;
    }>;
    observeNativePolicy?: (runtime: AgentSessionRuntime) => Promise<AgentMcpToolPolicyNativeObservation>;
    /** Enumerate actual Agent config files outside the launch observer's fixture HOME. */
    nativeConfigFiles?: () => readonly string[];
    /** Execute/inspect the loaded Agent's shell; return its full effective environment,
     * including selected machine-environment secret markers, not just spec.env additions. */
    observeToolShell?: (runtime: AgentSessionRuntime) => Promise<Readonly<{ argv: readonly string[]; env: Readonly<Record<string, string>> }>>;
    /** Exercise candidate controls without promoting a fixture trace to a manifest declaration. */
    candidateControl?: AgentMcpToolPolicyControl;
}>;

/** Internal assertion owner also used by kit sensitivity tests. */
export function assertMcpToolPolicyInvocation(input: Readonly<{
    expected: 'allow' | 'ask' | 'off' | 'deny'; control: AgentMcpToolPolicyControl;
    server: string; serverId: string; tool: string;
    invocation: AgentMcpToolPolicyInvocation; calls: readonly AgentMcpToolPolicyCallObservation[];
    /** Native hiding is a launch filter promise; live Off may be a host denial. */
    requireHidden?: boolean;
    /** Used by the host-denial characterization, not a native Off rule. */
    requireHostDenial?: boolean;
}>): void {
    const calls = input.calls.filter(call => call.server === input.server && call.tool === input.tool);
    const permissions = input.invocation.permissions;
    for (const permission of permissions) {
        assert.equal(permission.server, input.server, 'K9: host permission belongs to the requested server');
        assert.equal(permission.serverId, input.serverId, 'K9: duplicate titles do not change item identity');
        assert.equal(permission.tool, input.tool, 'K9: host permission belongs to the requested tool');
    }
    if (input.expected === 'off' || input.expected === 'deny') {
        assert.notEqual(input.invocation.outcome, 'completed', 'K8: denied tool cannot complete');
        assert.equal(input.calls.length, 0, 'K8: Off/deny must never reach either fixture server');
        assert.ok(permissions.every(permission => permission.decision === 'denied'), 'K8: denied tool is never approved');
        if (input.requireHidden) {
            assert.equal(input.invocation.outcome, 'hidden', 'K8: hidden declaration requires native absence, not call-time denial');
        } else if (input.requireHostDenial && input.invocation.outcome !== 'hidden') {
            assert.equal(permissions.length, 1, 'K8c: a blocked call reaches the actual host denial');
            assert.equal(permissions[0].prompted, false, 'K8c: Off/deny does not ask for approval');
        }
        return;
    }
    assert.equal(input.invocation.outcome, 'completed', 'K8: allowed invocation completes');
    assert.ok(permissions.every(permission => permission.decision === 'approved'), 'K8: a completed call cannot carry host denial');
    assert.equal(input.calls.length, 1, 'K8: exactly the requested fixture tool receives the call');
    assert.equal(calls.length, 1, 'K9: call reaches the requested server');
    if (input.control.approval === 'host' || input.expected === 'ask') {
        assert.equal(permissions.length, 1, 'K8c: a real call reaches the host permission handler');
        assert.equal(permissions[0].decision, 'approved', 'K8c: host approval settles before the call');
        assert.equal(permissions[0].prompted, input.expected === 'ask', 'K8c: Ask prompts and Allow auto-approves');
        assert.ok(permissions[0].order < calls[0].order, 'K8c: host handler precedes fixture server receipt');
    } else {
        assert.ok(permissions.every(permission => !permission.prompted), 'K8: native Allow does not ask');
        assert.ok(permissions.every(permission => permission.order < calls[0].order), 'K8: any observed host approval precedes server receipt');
    }
}

/** Keep decoded strings as well as serialized native artifacts: an escaped
 * newline/quote in a secret must not make a launch leak invisible. */
export function assertMcpToolPolicySecrets(secrets: readonly string[], artifacts: readonly unknown[]): void {
    const strings: string[] = [];
    const collect = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    artifacts.forEach(collect);
    for (const secret of secrets) {
        assert.ok(secret.length > 0, 'K7: a secret marker must not be empty');
        const escaped = JSON.stringify(secret).slice(1, -1);
        assert.ok(strings.every(artifact => !artifact.includes(secret) && !artifact.includes(escaped)),
            'K7: MCP secret leaked into Agent launch, native configuration, events or tool shell');
    }
}

function configuration(mode: AgentPermissionIntent): AgentSessionConfigurationSnapshot {
    return AgentSessionConfigurationSnapshotV1Schema.parse({ mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: mode, updatedAtMs: 0 }, options: {} });
}

/** Register K7/K8/K8b/K8c/K9 using actual leaf invocation and actual server receipts.
 * Boundary fixtures characterize wiring; only the separate real-vendor probes admit declarations. */
export function runAgentMcpToolPolicyContract(input: AgentMcpToolPolicyContractInput): void {
    const tools = 'tools' in input.agent.capabilities ? input.agent.capabilities.tools : undefined;
    const declared = tools?.mcpToolControl;
    const control = declared ?? input.candidateControl;
    const delivers = tools?.delivery === 'native_mcp' || tools?.delivery === 'native_extension';
    describe(`${input.agent.id} MCP tool policy${declared ? '' : control ? ' characterization (undeclared)' : ' unsupported'} contract`, () => {
        let cwd: string;
        let fixture: AgentMcpToolPolicyFixture;
        let sessionNumber = 0;
        const runtimes: AgentSessionRuntime[] = [];
        const projection = (setting: AgentMcpToolPolicySetting, mode: AgentPermissionIntent, hostMediation = control?.approval === 'host') => Object.fromEntries<AgentSessionMcpToolPolicy>(
            fixture.servers.map(server => {
                const projected = projectMcpToolLaunchPolicyV1({ policy: { default: 'ask', overrides: { [server.tool]: setting } },
                    snapshot: undefined, permissionMode: mode });
                return [server.key, hostMediation ? { unlisted: projected.unlisted === 'allow' ? 'ask' : projected.unlisted,
                    tools: Object.fromEntries(Object.entries(projected.tools).map(([name, value]) => [name, value === 'allow' ? 'ask' : value])) } : projected];
            }),
        );
        const apply = async (setting: AgentMcpToolPolicySetting, mode: AgentPermissionIntent = 'default', runtime?: AgentSessionRuntime, hostMediation?: boolean) => {
            const policy = projection(setting, mode, hostMediation);
            await input.fixtureServer.setPolicy({ runtime, permissionMode: mode,
                settings: Object.fromEntries(fixture.servers.map(server => [server.key, setting])),
                projection: policy, configuration: configuration(mode) });
            return policy;
        };
        const open = async (setting: AgentMcpToolPolicySetting = 'ask', mode: AgentPermissionIntent = 'default', hostMediation?: boolean) => {
            const policy = await apply(setting, mode, undefined, hostMediation);
            const runtime = await input.openSession({ kind: 'create', sessionId: `mcp-policy-contract-${++sessionNumber}`, cwd,
                configuration: configuration(mode), mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])),
                ...(control ? { mcpToolPolicy: policy } : {}) });
            runtimes.push(runtime);
            return runtime;
        };
        const invoke = async (runtime: AgentSessionRuntime, expected: 'ask' | 'allow' | 'off' | 'deny', index = 0, scope: 'once' | 'session' = 'once', requireHidden = false, requireHostDenial = false) => {
            assert.ok(control, 'A control is required for policy evidence');
            const server = fixture.servers[index];
            const before = input.fixtureServer.observeCalls().length;
            const invocation = await input.invokeTool(runtime, { server: server.key, tool: server.tool,
                arguments: {}, approvalScope: scope });
            assertMcpToolPolicyInvocation({ expected, control, server: server.key, serverId: server.serverId,
                tool: server.tool, invocation, calls: input.fixtureServer.observeCalls().slice(before), requireHidden, requireHostDenial });
        };
        const assertNative = async (runtime: AgentSessionRuntime, expected: Readonly<Record<string, AgentSessionMcpToolPolicy>>) => {
            assert.ok(input.observeNativePolicy, 'K8: native controls need native knob observations');
            const observation = await input.observeNativePolicy(runtime);
            assert.ok(observation.artifacts.length > 0, 'K8: actual native key/value artifacts are required');
            assert.deepEqual(observation.policy, expected, 'K8: actual native knobs match the current projection');
        };
        beforeEach(async () => {
            cwd = await mkdtemp(join(tmpdir(), 'happier-mcp-policy-contract-'));
            fixture = await input.fixtureServer.prepare({ cwd });
            assert.equal(fixture.servers[0].title, fixture.servers[1].title, 'K9 fixture must have duplicate titles');
            assert.notEqual(fixture.servers[0].key, fixture.servers[1].key, 'K9 fixture wire keys must differ');
            assert.notEqual(fixture.servers[0].serverId, fixture.servers[1].serverId, 'K9 fixture item ids must differ');
        });
        afterEach(async () => {
            try { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose(); }
            finally { try { await input.fixtureServer.dispose(); } finally { if (cwd) await rm(cwd, { recursive: true, force: true }); } }
        });
        it('K7 delivers servers without ambient secret disclosure', async () => {
            const runtime = await open();
            const artifacts: unknown[] = [];
            const collect = async () => {
                const launch = input.observeLaunch();
                artifacts.push(launch);
                for (const path of new Set([...launch.filesWritten, ...(input.nativeConfigFiles?.() ?? [])])) {
                    if (fixture.privateConfigFiles?.includes(path)) continue;
                    try {
                        if (!(await stat(path)).isFile()) continue;
                        // Native Agents also write large state/cache files. Scan
                        // all bytes without retaining each whole file as a string.
                        const overlap = Math.max(0, ...fixture.secrets.flatMap(secret => [secret.length,
                            JSON.stringify(secret).slice(1, -1).length])) - 1;
                        let tail = '';
                        for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
                            const text = tail + chunk;
                            assertMcpToolPolicySecrets(fixture.secrets, [text]);
                            tail = overlap > 0 ? text.slice(-overlap) : '';
                        }
                    }
                    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
                }
            };
            await collect();
            if (delivers) {
                assert.ok(fixture.secrets.length > 0, 'K7: secret-bearing server fixture is required');
                assert.ok(input.observeToolShell, 'K7: observe the actual Agent tool shell');
                artifacts.push(await input.observeToolShell(runtime));
                const before = input.fixtureServer.observeCalls().length;
                const server = fixture.servers[0];
                const result = await input.invokeTool(runtime, { server: server.key, tool: server.tool, arguments: {}, approvalScope: 'once' });
                assert.equal(result.outcome, 'completed', 'K7: actual MCP transport succeeds');
                assert.equal(input.fixtureServer.observeCalls().slice(before).filter(call => call.server === server.key && call.tool === server.tool).length, 1);
                // Calls can write native configuration and publish events. Inspect the
                // actual post-call observation, not just launch-time arguments.
                await collect();
                artifacts.push(await input.observeToolShell(runtime));
            } else {
                assert.equal(declared, undefined, 'Agents without MCP delivery cannot declare controls');
            }
            assertMcpToolPolicySecrets(fixture.secrets, artifacts);
        });
        if (!control) {
            it('does not claim K8/K8b/K8c support when the declaration is absent', () => assert.equal(declared, undefined));
            return;
        }
        it.each(['off', 'ask', 'allow'] as const)('K8 applies %s through real calls', async setting => {
            const runtime = await open(setting);
            if (control.approval === 'native') await assertNative(runtime, projection(setting, 'default'));
            await invoke(runtime, setting, 0, 'once', setting === 'off' && control.off === 'hidden');
        });
        it('K8 preserves the mode ceiling on the next real call', async () => {
            const runtime = await open('allow');
            await invoke(runtime, 'allow');
            const policy = await apply('allow', 'read-only', runtime);
            if (control.approval === 'native') await assertNative(runtime, policy);
            await invoke(runtime, 'deny');
        });
        if (control.approval === 'native') {
            it('K8b revokes Allow at unchanged mode via the existing update carrier', async () => {
                for (const setting of ['off', 'ask'] as const) {
                    const runtime = await open('allow');
                    await invoke(runtime, 'allow');
                    const policy = await apply(setting, 'default', runtime);
                    await assertNative(runtime, policy);
                    await invoke(runtime, setting);
                }
            });
        } else {
            it.skip('K8b unsupported: no native revocation declaration', () => {});
        }
        it('K8c mediates Ask before receipt, blocks Off and auto-approves projected Ask for Allow', async () => {
            const runtime = await open('ask', 'default', true);
            await invoke(runtime, 'ask');
            await apply('off', 'default', runtime, true);
            await invoke(runtime, 'off', 0, 'once', false, true);
            const policy = await apply('allow', 'default', runtime, true);
            assert.equal(policy[fixture.servers[0].key].tools[fixture.servers[0].tool], 'ask');
            const server = fixture.servers[0];
            const before = input.fixtureServer.observeCalls().length;
            const invocation = await input.invokeTool(runtime, { server: server.key, tool: server.tool, arguments: {}, approvalScope: 'once' });
            assertMcpToolPolicyInvocation({ expected: 'allow', control: { ...control, approval: 'host' },
                server: server.key, serverId: server.serverId, tool: server.tool, invocation,
                calls: input.fixtureServer.observeCalls().slice(before) });
        });
        it('K9 isolates session grants and duplicate-title server identities', async () => {
            const runtime = await open('ask');
            await invoke(runtime, 'ask', 0, 'session');
            await invoke(runtime, 'allow', 0);
            await invoke(runtime, 'ask', 1);
            // A native session-wide approval must not bypass the new live Off.
            await apply('off', 'default', runtime);
            await invoke(runtime, 'off', 0);
            await apply('off', 'yolo', runtime);
            await invoke(runtime, 'off', 0);
        });
    });
}
