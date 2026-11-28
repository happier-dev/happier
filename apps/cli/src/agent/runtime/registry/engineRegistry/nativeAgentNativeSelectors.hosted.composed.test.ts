import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { bindPluginExecProcessOwnerForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { resolveClaudeInstalledEffortSupport } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createGeminiAgentRuntime } from '../../../../../../../packages/plugins/gemini/src/agent/runtime/factory';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { createExternalContributionFixtures, createLease, createNativeAgentRuntimeSessionPlanFixture,
    createNativeSessionClientTestPort } from './nativeAgentSession.composed.testkit';

const nativeSession = (): AgentSessionRuntime => ({ send: async () => ({ status: 'admitted' }),
    watch: () => ({ dispose() {} }), dispose: async () => {} });

async function launchNativeSelectorProbe(input: Readonly<{
    agent: 'claude' | 'gemini'; directory: string; id: string;
    overrides: Readonly<Record<string, string>>; unset: readonly string[];
}>) {
    const outputPath = join(input.directory, `${input.agent}-${input.id}.json`);
    const script = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(Object.fromEntries(
        ['USER','IS_SANDBOX','GEMINI_CLI_HOME','XDG_CONFIG_HOME','GEMINI_CLI_SYSTEM_SETTINGS_PATH',
        'GEMINI_CLI_SYSTEM_DEFAULTS_PATH','PRIVATE_NATIVE_SECRET'].map(key => [key, process.env[key]]))));
        process.stdout.write('--effort <level> --acp');`;
    const runtime: AgentRuntime = { sessions: { async open(request, context) {
        if (input.agent === 'claude') {
            expect(await resolveClaudeInstalledEffortSupport({ request, context })).toBe(true);
            return nativeSession();
        }
        // ACP is the native protocol/process boundary. Native preparation and
        // its real supervised help probe remain composed beneath this adapter.
        return await createGeminiAgentRuntime().sessions.open(request, { ...context,
            protocols: { ...context.protocols, acp: { ...context.protocols.acp, open: async () => nativeSession() } },
        });
    } } };
    const agentId = `selector-${input.agent}`;
    const lease = createLease(agentId);
    const contributions = createExternalContributionFixtures(agentId);
    const plan = await createNativeAgentRuntimeSessionPlanFixture({ runtime, lease, ...contributions,
        createSessionHostServiceOwners: args => createNativeAgentSessionHostServiceOwners({ ...args,
            runtimeRegistry: null, identity: lease, ...contributions, hostSession: args.hostRuntimeParams }),
        createInvocationServices: async args => ({ ...createUnavailablePluginServices(),
            exec: createStablePluginExecService({ signal: args.signal, environment: args.environment,
                isOccurrenceCurrent: () => true, resolvePath: async () => input.directory,
                // Executable resolution is the OS boundary; real Exec merging,
                // supervision, admission and process cleanup are exercised.
                resolveExecutable: async () => ({ command: process.execPath, args: ['--eval', script, '--'] }),
                systemTools: { resolve: async request => ({ grantId: `${input.agent}-${input.id}`,
                    toolId: request.toolId, displayName: 'Native selector probe', source: 'system',
                    executablePath: outputPath,
                    launch: { kind: 'binary', executablePath: process.execPath, args: ['--eval', script, '--'] },
                }) },
            }),
        }),
        sessionInput: buildPluginSessionBindingInput({ credentials: { token: 'native-selector-fixture', encryption: null },
            directory: input.directory, backendTarget: { kind: 'backend', backendId: agentId },
            environmentVariables: { GEMINI_API_KEY: 'fixture', ...input.overrides }, unsetEnvironmentVariables: input.unset,
        }),
    });
    const created = await plan.config.createSessionRuntime({ directory: input.directory, metadata: {}, machineId: 'machine',
        session: createNativeSessionClientTestPort(`selector-${input.agent}-${input.id}`), transcriptSession: {}, messageBuffer: {},
        mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
    } as never);
    try { return JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, string>; }
    finally { await created.operations.resetOrDisposeRuntime('session_closed'); }
}

describe('native Agent selectors inherit the admitted Session baseline', () => {
    it('uses Windows environment identity and the last authored selector spelling', () => {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        try {
            Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
            const exec = createStablePluginExecService({ signal: new AbortController().signal,
                inheritedEnvironment: { Native_Selector: 'earlier', NATIVE_SELECTOR: 'winning' },
                isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => '/repo',
            });
            expect(exec.readEnvironment?.(['NATIVE_SELECTOR', 'MISSING'])).toEqual({ NATIVE_SELECTOR: 'winning' });
        } finally { Object.defineProperty(process, 'platform', descriptor); }
    });

    it('keeps the captured baseline through a later scope and owner binding without widening process launches', () => {
        const environment = { NATIVE_SELECTOR: 'session-a', PRIVATE_NATIVE_SECRET: 'private' };
        const exec = runAddedHostedSession({ environment, workingDirectory: '/repo', end() {} }, () =>
            createStablePluginExecService({ signal: new AbortController().signal, environment: { HOME: '/projected' },
                isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => '/repo',
            }));
        runAddedHostedSession({ environment: { NATIVE_SELECTOR: 'session-b' }, workingDirectory: '/repo', end() {} }, () => {
            const rebound = bindPluginExecProcessOwnerForHost(exec, { kind: 'session', sessionId: 'session-a' });
            expect(rebound.readEnvironment?.(['NATIVE_SELECTOR', 'MISSING'])).toEqual({ NATIVE_SELECTOR: 'session-a' });
            environment.NATIVE_SELECTOR = 'updated-a';
            expect(rebound.readEnvironment?.(['NATIVE_SELECTOR'])).toEqual({ NATIVE_SELECTOR: 'updated-a' });
        });
    });

    it.each(['claude', 'gemini'] as const)('keeps two %s Sessions distinct with inheritance, absence, overrides and unsets', async agent => {
        const directory = await mkdtemp(join(tmpdir(), 'native-selectors-'));
        try {
            for (const mode of ['inherit', 'absent', 'override', 'unset'] as const) {
                const outputs = await Promise.all(['a', 'b'].map(id => {
                    const selectors = { USER: `session-${id}`, IS_SANDBOX: '1', GEMINI_CLI_HOME: join(directory, id),
                        XDG_CONFIG_HOME: join(directory, `xdg-${id}`),
                        GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, `${id}-settings.json`),
                        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(directory, `${id}-defaults.json`) };
                    return runAddedHostedSession({ environment: { HOME: directory, PATH: process.env.PATH,
                        PRIVATE_NATIVE_SECRET: 'must-not-project', ...(mode === 'absent' ? {} : selectors) },
                        workingDirectory: directory, end() {},
                    }, () => launchNativeSelectorProbe({ agent, directory, id: `${mode}-${id}`,
                        overrides: mode === 'override' ? { USER: `explicit-${id}`, IS_SANDBOX: '0',
                            GEMINI_CLI_HOME: join(directory, `explicit-${id}`),
                            GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, `explicit-${id}-settings.json`) } : {},
                        unset: mode === 'unset' ? Object.keys(selectors) : [],
                    }));
                }));
                for (const [index, id] of ['a', 'b'].entries()) {
                    // Gemini deliberately materializes a private CLI home;
                    // its unmodified system selector reveals the inherited source.
                    const key = agent === 'claude' ? 'USER' : 'GEMINI_CLI_SYSTEM_SETTINGS_PATH';
                    expect(outputs[index]?.[key], `${agent} ${mode} ${id}`).toBe(mode === 'inherit'
                        ? agent === 'claude' ? `session-${id}` : join(directory, `${id}-settings.json`)
                        : mode === 'override' ? agent === 'claude' ? `explicit-${id}` : join(directory, `explicit-${id}-settings.json`)
                            : undefined);
                    if (agent === 'claude') expect(outputs[index]?.IS_SANDBOX).toBe(mode === 'inherit' ? '1' : mode === 'override' ? '0' : undefined);
                    expect(outputs[index]).not.toHaveProperty('PRIVATE_NATIVE_SECRET');
                }
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
