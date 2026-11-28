import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import type { AgentExecutionRunOpenRequest, AgentRuntime, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { resolveBackendIsolationBundle } from '@/packagedRuntime/isolation/resolveBackendIsolationBundle';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { createExternalContributionFixtures, createLease, createNativeAgentRuntimeSessionPlanFixture,
    createNativeSessionClientTestPort } from './nativeAgentSession.composed.testkit';

type OpenRequest = AgentSessionOpenRequest | AgentExecutionRunOpenRequest;

const environmentFor = (id: string): NodeJS.ProcessEnv => ({
    HOME: `/home/${id}`, USERPROFILE: `C:\\Users\\${id}`, PATH: `/tools/${id}`,
    NODE_EXTRA_CA_CERTS: `/certs/${id}.pem`, AGENT_BROWSER_IDLE_TIMEOUT_MS: id === 'a' ? '17000' : '23000',
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['OPENAI_API_KEY']),
    OPENAI_API_KEY: `connected-service-${id}`,
});

async function openAtNativeBoundary(kind: 'session' | 'run' | 'isolated-run', id: string, options?: Readonly<{
    catalogEntry: ResolvedAgentContribution['catalogEntry'];
    environmentVariables?: Readonly<Record<string, string>>;
    readNativeHome(context: AgentSessionRuntimeContext): Promise<void>;
}>) {
    let opened: OpenRequest | undefined;
    // The Agent implementation is the external native boundary; all launch,
    // isolation, Session host services and Run lifecycle owners remain real.
    const runtime: AgentRuntime = {
        sessions: { async open(request, context) {
            opened = request;
            await options?.readNativeHome(context);
            await Promise.resolve();
            return { send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }), dispose: async () => {} };
        } },
        executionRuns: { async open(request) {
            opened = request;
            await Promise.resolve();
            return { send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }),
                stop: async () => ({ status: 'notRunning' }), dispose: async () => {} };
        } },
    };
    const agentId = 'acme-environment';
    const lease = createLease(agentId);
    if (kind === 'session') {
        const baseContributions = createExternalContributionFixtures(agentId);
        const contributions = { ...baseContributions, agent: { ...baseContributions.agent,
            ...(options ? { catalogEntry: options.catalogEntry } : {}),
        } };
        const plan = await createNativeAgentRuntimeSessionPlanFixture({
            runtime, lease, ...contributions,
            createSessionHostServiceOwners: input => createNativeAgentSessionHostServiceOwners({
                ...input, runtimeRegistry: null, identity: lease, ...contributions, hostSession: input.hostRuntimeParams,
            }),
            sessionInput: buildPluginSessionBindingInput({ credentials: { token: 'native-env-fixture', encryption: null },
                directory: '/repo', backendTarget: { kind: 'backend', backendId: agentId },
                environmentVariables: { ...options?.environmentVariables, EXPLICIT_NATIVE_ENV: id, ...(id === 'b' ? { NODE_EXTRA_CA_CERTS: `/override/${id}.pem` } : {}) },
            }),
        });
        // Only the Session client transport fields reached by native open are
        // supplied; the real owner composes every internal Session service.
        const created = await plan.config.createSessionRuntime({
            directory: '/repo', metadata: {}, machineId: 'machine', session: createNativeSessionClientTestPort(`session-${id}`),
            transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
            getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
        } as never);
        await created.operations.resetOrDisposeRuntime('session_closed');
    } else {
        const isolation = kind === 'isolated-run' ? resolveBackendIsolationBundle({ backendId: agentId,
            isolationId: `run-${id}`, scope: 'execution_run', cwd: '/repo', intent: 'delegate' }) : { env: {} };
        const host = createNativeAgentExecutionRunHostRuntime({ runtime, lease, supportsResume: false,
            options: { cwd: '/repo', runId: `run-${id}`, scope: 'detached', backendId: agentId, permissionMode: 'no_tools',
                isolation: { env: { ...isolation.env, EXPLICIT_NATIVE_ENV: id, ...(id === 'b' ? { NODE_EXTRA_CA_CERTS: `/override/${id}.pem` } : {}) } },
                start: { intent: 'delegate', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
        });
        try {
            const { runtimeId } = await host.provisionRuntime();
            await host.deliverInput(runtimeId, { text: 'Observe native launch environment.' });
        } finally { await host.dispose(); }
    }
    if (!opened) throw new Error('Native open was not reached');
    return opened.launchEnvironment?.values;
}

describe('native launch hosted Session baseline', () => {
    it.each(['session', 'run', 'isolated-run'] as const)('keeps interleaved %s launches on their own environment with explicit overrides', async kind => {
        const values = await Promise.all(['a', 'b'].map(id => runAddedHostedSession({
            environment: environmentFor(id), workingDirectory: '/repo', end() {},
        }, async () => {
            await Promise.resolve();
            return openAtNativeBoundary(kind, id);
        })));
        for (const [index, id] of ['a', 'b'].entries()) {
            expect(values[index]).toMatchObject({ HOME: `/home/${id}`, PATH: `/tools/${id}`,
                NODE_EXTRA_CA_CERTS: id === 'b' ? `/override/${id}.pem` : `/certs/${id}.pem`, EXPLICIT_NATIVE_ENV: id,
                AGENT_BROWSER_IDLE_TIMEOUT_MS: id === 'a' ? '17000' : '23000' });
            if (process.platform === 'win32') expect(values[index]?.USERPROFILE).toBe(`C:\\Users\\${id}`);
            expect(values[index]?.OPENAI_API_KEY).toBeUndefined();
        }
    });

    it.each([false, true])('reads each Session native home with explicit native-root override %s', async explicitRoot => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-session-home-'));
        try {
            const observed = await Promise.all(['a', 'b'].map(async id => {
                const home = join(root, id);
                const nativeRoot = explicitRoot ? join(root, `override-${id}`) : join(home, '.happier-ambient-scope-hunt-1113-fixture');
                await mkdir(nativeRoot, { recursive: true });
                await writeFile(join(nativeRoot, 'AMBIENT-SCOPE-HUNT-1113.marker.json'), JSON.stringify({ account: id }));
                return runAddedHostedSession({ environment: { ...environmentFor(id), HOME: home, USERPROFILE: home,
                    ...(explicitRoot ? { ACME_NATIVE_HOME: nativeRoot } : {}) }, workingDirectory: '/repo', end() {},
                }, async () => {
                    let account: unknown;
                    await Promise.resolve();
                    await openAtNativeBoundary('session', id, {
                        environmentVariables: explicitRoot ? { ACME_NATIVE_HOME: nativeRoot } : {},
                        // This external Agent declares its native credential root. Home
                        // resolution and restricted file access remain production owners.
                        catalogEntry: { id: 'acme-environment', cliSubcommand: 'acme-environment',
                            getConnectedServiceStateSharingDescriptor: async () => ({
                                providerId: 'acme', providerSupportStatus: 'supported',
                                config: { supported: true, modes: ['isolated'], entries: [] },
                                state: { supported: true, modes: ['isolated'], entries: [],
                                    symlinkUnavailableDegradePolicy: 'block_continuity' },
                                authIsolation: { mode: 'materialized_home', secretEntries: ['AMBIENT-SCOPE-HUNT-1113.marker.json'] },
                                nativeHome: { environmentKey: 'ACME_NATIVE_HOME', defaultRelativePath: '.happier-ambient-scope-hunt-1113-fixture' },
                            }),
                        },
                        async readNativeHome(context) {
                            expect(context.session.services.nativeHome).toBeDefined();
                            const files = await context.session.services.nativeHome!.readFiles(['AMBIENT-SCOPE-HUNT-1113.marker.json']);
                            account = files?.['AMBIENT-SCOPE-HUNT-1113.marker.json'] ? JSON.parse(new TextDecoder().decode(files['AMBIENT-SCOPE-HUNT-1113.marker.json'])) : null;
                        },
                    });
                    return account;
                });
            }));
            expect(observed).toEqual([{ account: 'a' }, { account: 'b' }]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('uses the process baseline outside a hosted Session', async () => {
        const values = await openAtNativeBoundary('run', 'unscoped');
        expect(values?.HOME).toBe(process.env.HOME);
        expect(values?.PATH).toBe(process.env.PATH);
    });
});
