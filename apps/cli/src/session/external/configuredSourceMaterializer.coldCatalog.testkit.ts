import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME } from '@happier-dev/protocol/agents/codex/native-home-policy';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readRegistryCatalogHook } from '@/agent/catalog/runtimeEntry';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { materializeConfiguredExternalSessionSourceCandidates } from './configuredSourceMaterializer';

export async function coldConnectedHome(params?: Readonly<{
    runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    agentId: string;
    serviceId: string;
}>) {
    const runtime = params?.runtime ?? await createAdmittedPluginRuntimeFixture();
    const agentId = params?.agentId ?? 'codex';
    const serviceId = params?.serviceId ?? 'openai-codex';
    try {
        const activeServerDir = join(runtime.happyHomeDir, 'active-server');
        const profileId = '7e9ced1f-60ac-4618-bcf0-31adc1c2e4aa';
        const remoteSessionId = '11111111-1111-4111-8111-111111111111';
        const homePath = join(resolveConnectedServiceHomeDir({ activeServerDir, agentId,
            serviceId, profileId }), CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME);
        await mkdir(join(homePath, 'sessions'), { recursive: true });
        await writeFile(join(homePath, 'sessions', `rollout-${remoteSessionId}.jsonl`),
            JSON.stringify({ type: 'session_meta', timestamp: '2026-10-01T00:00:00.000Z',
                payload: { id: remoteSessionId, cwd: '/project', timestamp: '2026-10-01T00:00:00.000Z' } }) + '\n'
            + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
                content: [{ type: 'input_text', text: 'connected home fixture' }] } }) + '\n');
        const userHome = join(runtime.happyHomeDir, 'user-codex');
        await mkdir(join(userHome, 'sessions'), { recursive: true });
        vi.stubEnv('CODEX_HOME', userHome);
        const account = AccountProfileSchema.parse({ id: 'account', connectedServicesV2: [{
            serviceId, profiles: [{ profileId, status: 'connected', kind: 'oauth',
                providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null }], groups: [],
        }] });
        const agents = runtime.registry.contributes.agents.filter(agent => agent.id === agentId);
        const source = materializeConfiguredExternalSessionSourceCandidates({ agents, account })
            .flatMap(row => row.source === undefined ? [] : [ExternalSessionsSourceSchema.parse(row.source)])
            .find(candidate => candidate.home === 'connectedService');
        if (!source) throw new Error('Expected real connected-profile producer');
        const resolveCatalogEntry = async (agentId: string) =>
            await readRegistryCatalogHook(runtime.registry, agentId, entry => entry);
        const resolveBoundary = async (agentId: string) => {
            const catalogEntry = await resolveCatalogEntry(agentId);
            const current = runtime.registry.agentRuntimesByAgentId.get(agentId);
            if (!current?.externalSessions) return null;
            return { catalogEntry, externalSessions: current.externalSessions, occurrenceId: current.occurrenceId,
                retirementSignal: current.retirementSignal, isCurrent: current.isCurrent };
        };
        const resolveProviderOps = async (agentId: string) => {
            const boundary = await resolveBoundary(agentId);
            if (!boundary) return null;
            const surface = createAgentExternalSessionsExecutionSurface(boundary.externalSessions);
            if (!surface.validateSource || !surface.listCandidates || !surface.resolveLinkIdentity || !surface.pageTranscript || !surface.readAfterTranscript) {
                throw new Error('Expected real native transcript operations');
            }
            return { ...surface, validateSource: surface.validateSource, listCandidates: surface.listCandidates, resolveLinkIdentity: surface.resolveLinkIdentity,
                pageTranscript: surface.pageTranscript, readAfterTranscript: surface.readAfterTranscript };
        };
        expect(runtime.registry.agentRuntimesByAgentId.has(agentId)).toBe(false);
        const basis = { accountSettingsRevision: 'account:1' };
        const signal: AbortSignal = new AbortController().signal;
        return { runtime, homePath, source, remoteSessionId, resolveBoundary, resolveProviderOps,
            input: { agents, account, activeServerId: 'home', activeServerDir, signal,
                resolveBoundary, resolveCatalogEntry, basis, readCurrentBasis: () => basis,
                isCurrent: () => runtime.controller.isRuntimeRegistryCurrent(runtime.registry),
                resolveAgentOccurrence: () => ({ occurrenceId: 'captured-registry', isCurrent: () => true }),
                resolveProviderOps } };
    } catch (error) { await runtime.dispose(); throw error; }
}
