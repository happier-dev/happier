import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';

let withFixture: typeof import('../agentRuntime/foregroundAdmission.testkit').withRealForegroundAdmissionFixture;
let createAdmission: typeof import('../agentRuntime/foregroundAdmission').createForegroundAgentRuntimeAdmissionOwner;
let createCandidate: typeof import('@/plugins/testkit/admittedRuntime').createAuthoredAdmittedPluginRuntimeFixture;
let captureScope: typeof import('./nativeAuthRuntimeRefresh').captureSessionNativeAuthRuntimeRefreshScope;
let manifest: typeof import('@/plugins/testkit/manifestV2Fixture').createPluginManifestV2Fixture;
let createPurposeFixture: typeof import('./refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit').createBuiltInQualifiedNativeRefreshHarness;

const pluginId = 'acme.native-auth';
const agentId = 'acme.native-auth/fixture';
const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
function plugin(version: string) {
    return { manifest: manifest({ id: pluginId, version,
        contributes: { agents: [{ id: 'fixture', title: 'Native auth fixture', primary: 'sessions', runtime: { kind: 'custom' },
            cli: { displayName: 'Fixture', executable: { binaryName: 'native-auth-fixture', sourcePreference: 'system-first' },
                install: { manual: { kind: 'none' } }, auth: { support: 'unsupported', loginLaunches: [] } },
            capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
            connectedAccounts: [{ purpose: 'primary', service, materializationKinds: ['files'] }],
        }] } }), files: {
        'agent-runtime.mjs': 'export function createRuntime() { return { sessions: { async open(request) { return { sessionId: request.sessionId, async send() { return { status: "admitted" }; }, watch() { return { dispose() {} }; }, async dispose() {} }; } } }; }',
        'daemon.mjs': `import { createRuntime } from './agent-runtime.mjs';
export function activate(api) { api.agents.register('fixture', createRuntime, {
sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
connectedAccountLaunch: { continuity: { nativeAuthCodec: {
materialize() { return { files: {} }; }, inspect() { return { status: 'unavailable', retryable: false, reason: 'fixture' }; },
runtimeAuthRefresh: { purpose: 'primary', materialization: { kind: 'files', fileIds: ['auth.json'] },
decode() { return { accessToken: 'must-not-disclose' }; } }
} } } }); }`,
    } };
}

beforeEach(async () => {
    vi.resetModules();
    ({ withRealForegroundAdmissionFixture: withFixture } = await import('../agentRuntime/foregroundAdmission.testkit'));
    ({ createForegroundAgentRuntimeAdmissionOwner: createAdmission } = await import('../agentRuntime/foregroundAdmission'));
    ({ createAuthoredAdmittedPluginRuntimeFixture: createCandidate } = await import('@/plugins/testkit/admittedRuntime'));
    ({ captureSessionNativeAuthRuntimeRefreshScope: captureScope } = await import('./nativeAuthRuntimeRefresh'));
    ({ createPluginManifestV2Fixture: manifest } = await import('@/plugins/testkit/manifestV2Fixture'));
    ({ createBuiltInQualifiedNativeRefreshHarness: createPurposeFixture } = await import('./refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit'));
});
afterEach(() => vi.restoreAllMocks());

describe('native auth Session codec source authority', () => {
    it('does not substitute a successor codec for the real claimed foreground Agent source', async () => {
        await withFixture({ plugins: [plugin('1.0.0')] }, async (fixture) => {
            // This is an admitted plugin Agent, not a configured ACP backend. Its canonical
            // routing target carries the actual Agent id and no configured-backend identity.
            const overrides = { agentId, backendTarget: { kind: 'backend' as const, backendId: agentId } };
            // The current unbound foreground flow still retains exact Agent source authority.
            // This test proves only its secret-free codec/scope projection; the native and HTTP
            // suites separately exercise the actual bound-account materialization owner.
            const purposeFixture = await createPurposeFixture({ controller: fixture.runtime.controller,
                happyHomeDir: fixture.home });
            const admission = createAdmission({ prepare: async () => fixture.prepare(overrides, {
                activateSessionPurposeBindings: purposeFixture.purposeRuntime.activateSessionPurposeBindings,
                resolveExternalAgentSessionPurposeBindingSnapshot: ({ authorizedPurposes, signal }) =>
                    purposeFixture.purposeRuntime.resolveCurrentSessionPurposeBindingSnapshot({ authorizedPurposes, signal }),
            }), getHttpPort: () => 40123 });
            try {
                const admitted = await admission.admit(fixture.request(overrides));
                if (!admitted.ok) throw new Error(admitted.error.code);
                const descriptor = admitted.capability.descriptor;
                const contents: unknown = JSON.parse(await readFile(admitted.capability.admissionFilePath, 'utf8'));
                const capability = z.object({ capability: z.string() }).passthrough().parse(contents).capability;
                await admission.claimEnvironment({ v: 1, attemptId: 'attempt-1', provisionalSessionId: 'session-1',
                    canonicalSessionId: 'session-1', foregroundPid: fixture.foregroundPid,
                    pluginId: descriptor.pluginId, agentId: descriptor.agentId, occurrenceId: descriptor.occurrenceId,
                    sourceCustody: descriptor.sourceCustody, capability, foregroundSatisfiedProfileSecretRequirementNames: [] });
                const retainedAgentAuthority = admission.readCurrentSessionAgentAuthority('session-1');
                if (!retainedAgentAuthority) throw new Error('Real claimed foreground source unavailable');
                const bindings = ConnectedServiceBindingsV2IngressSchema.parse({ v: 2, bindingsByServiceId: {
                    'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
                } });
                const retainedCodec = await (await fixture.runtime.registry.acquireAgentCatalogEntry?.(agentId))
                    ?.getConnectedAccountNativeAuthRefreshCodec?.();
                if (!retainedCodec) throw new Error('Actual retained-source codec unavailable');
                const matchingInput = { sessionId: 'session-1', agentId, bindings,
                    registry: fixture.runtime.registry, codec: retainedCodec, retainedAgentAuthority,
                    isCurrent: () => retainedAgentAuthority.isCurrent()
                        && fixture.runtime.controller.isRuntimeRegistryCurrent(fixture.runtime.registry) };
                expect(captureScope(matchingInput)).not.toBeNull();
                const candidate = await createCandidate({ plugins: [plugin('2.0.0')] });
                try {
                    const codec = await (await candidate.registry.acquireAgentCatalogEntry?.(agentId))?.getConnectedAccountNativeAuthRefreshCodec?.();
                    if (!codec) throw new Error('Actual successor codec unavailable');
                    const input = { sessionId: 'session-1', agentId,
                        bindings, registry: candidate.registry, codec,
                        retainedAgentAuthority,
                        isCurrent: () => retainedAgentAuthority.isCurrent() && candidate.controller.isRuntimeRegistryCurrent(candidate.registry),
                    };
                    expect(captureScope(input)).toBeNull();
                } finally { await candidate.dispose(); }
            } finally { await admission.dispose(); await purposeFixture.dispose(); }
        });
    });
});
