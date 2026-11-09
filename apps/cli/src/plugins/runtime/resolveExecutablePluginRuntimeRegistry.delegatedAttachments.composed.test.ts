import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';

const triageId = 'happier.triage';
const channelsId = 'happier.channels';
const relayId = 'example.unrelated-relay';
const sessionId = 'c123456789012345678901234';
const machineId = 'attachdeleg-machine';
const credentials = { token: 'attachdeleg-token', encryption: null } as const;

function readAttachments(content: Parameters<CliActionMachineAdmissionTransport>[0]['content']) {
    if (content.t !== 'plain') throw new Error('Expected plain boundary content');
    const body = content.v;
    if (!body || typeof body !== 'object' || !('meta' in body)) throw new Error('Expected Message metadata');
    return readHappierStructuredInputV1FromMeta(body.meta)?.composerAttachments;
}

// Credentials and Home/Machine transport are system boundaries. Source
// admission, SDK services, caller stamping, Actions and attachment lifecycle
// all run their production owners, including the real Session sender.
vi.mock('@/persistence', async original => ({
    ...await original<typeof import('@/persistence')>(),
    readStoredCredentials: async () => credentials,
}));
afterEach(() => { vi.unstubAllGlobals(); });

async function fixture(ownEntry = false, identities = { triageId, channelsId }) {
    const { triageId, channelsId } = identities;
    const home = fastify();
    const homeUrl = 'http://attachdeleg-home.test';
    const writes: Parameters<CliActionMachineAdmissionTransport>[0][] = [];
    const pending = new Map<string, unknown>();
    const preparedBy: string[] = [];
    const callers: unknown[] = [];
    const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId, permissionMode: 'yolo' }) });
    home.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    home.get(`/v2/sessions/${sessionId}`, async () => ({ session }));
    home.get(`/v2/sessions/${sessionId}/pending`, async () => ({
        pending: [...pending].map(([localId, content]) => ({ localId, content })),
    }));
    home.get(`/v2/sessions/${sessionId}/messages/by-local-id/:localId`, async (_request, reply) =>
        reply.status(404).send({ error: 'Message not found' }));
    const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ features: {},
        capabilities: { session: { pendingInput: { protocolVersion: 5 } } } }), { status: 200 }));
    const attachment = (pluginId: string) => ({
        title: 'Entry', icon: 'error', cardinality: 'many' as const,
        value: defineProtocolObject({}, { policy: 'closed' }),
        runtime: { async prepareForSend(request: Parameters<NonNullable<import('@happier-dev/plugin-sdk').ComposerAttachmentRuntime['prepareForSend']>>[0]) {
            preparedBy.push(pluginId);
            return { attachments: request.attachments.map(item => ({ instanceId: item.instanceId,
                status: 'ready' as const, value: item.value })) };
        } },
    });
    const inputSchema = defineProtocolObject({ localId: defineProtocolString(), key: defineProtocolString(),
        forgeCaller: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
    }, { policy: 'closed' });
    const triage = definePlugin({ id: triageId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        composer: { attachments: { entry: attachment(triageId) } },
        actions: { delegate: { title: 'Delegate', surfaces: ['cli'], dangerLevel: 'safe', inputSchema,
            run: async (input, context) => context.services.actions.execute({ pluginId: channelsId, localId: 'send' }, input) },
        relay: { title: 'Relay', surfaces: ['cli'], dangerLevel: 'safe', inputSchema,
            run: async (input, context) => context.services.actions.execute({ pluginId: relayId, localId: 'relay' }, input) } },
    });
    const relay = definePlugin({ id: relayId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { relay: { title: 'Relay', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema,
            run: async (input, context) => context.services.actions.execute({ pluginId: channelsId, localId: 'send' }, input) } },
    });
    const channels = definePlugin({ id: channelsId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        hostAccess: { required: [{ id: 'sessions', capability: 'sessions', reason: 'Send selected input',
            scope: { access: ['read', 'write'] } }], optional: [] },
        composer: { attachments: { own: attachment(channelsId), ...(ownEntry ? { entry: attachment(channelsId) } : {}) } },
        actions: { send: { title: 'Send', surfaces: ['cli', 'plugin'], dangerLevel: 'safe', hostAccess: ['sessions'], inputSchema,
            async run(input, context) {
                callers.push(context.caller);
                const session = await context.services.sessions.get(sessionId);
                if (!session) throw new Error('Selected Session unavailable');
                return await session.send({ kind: 'userText', text: 'Review selected entry',
                    idempotencyKey: input.key ?? 'entry-send',
                    attachments: [{ attachmentLocalId: input.localId ?? 'entry',
                        value: { key: 'entry:42', value: {}, presentation: { label: 'Entry 42' } },
                        ...(input.forgeCaller ? { pluginId: triageId } : {}),
                    }],
                    ...(input.forgeCaller ? { initiatingCaller: { kind: 'plugin', pluginId: triageId } } : {}),
                });
            } } },
    });
    const runtime = await runWithServerHttpBaseUrl(homeUrl, async () => createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [triage, channels, relay].map(plugin => ({ manifest: plugin.manifest,
            files: { 'daemon.mjs': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }) })),
        async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
            // Isolate these authored declarations from the bundled Triage and
            // Channels copies; installed source custody still uses the store.
            loadResult: await loadInstalledPlugins({ happyHomeDir }),
            provenance: triageId === 'happier.triage' ? 'first_party' : 'external',
        })); },
        runtimeOptions: {
            scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({
                getAccountSettings: () => ({ actionsSettingsV1: { v: 1, actions: {},
                    approvalWaivedSurfaces: { 'session.message.send': ['plugin'] } } }), allowEnvironmentOverride: false,
            }) },
            resolveCurrentMachineId: () => machineId,
            machineAdmissionTransport: async request => {
                writes.push(request);
                const exists = pending.has(request.localId);
                pending.set(request.localId, JSON.parse(JSON.stringify(request.content)));
                return { status: exists ? 'alreadyAccepted' : 'accepted', localId: request.localId };
            },
        },
    }));
    return { writes, pending, preparedBy, callers,
        async invoke(pluginId: string, localId: string, input: { localId?: string; key?: string; forgeCaller?: boolean } = {}) {
            return await runWithServerHttpBaseUrl(homeUrl, () => runtime.registry.targetActionInvocations!.invoke({
                pluginId, localId, input: { localId: 'entry', key: 'entry-send', forgeCaller: false, ...input }, surface: 'cli',
            }));
        },
        async dispose() { try { await runtime.dispose(); } finally { restoreHttp(); await home.close(); } },
    };
}

describe('delegated Session attachment admission through external SDK Actions', () => {
    it.each([{ triageId, channelsId }, { triageId: 'example.attachdeleg-triage', channelsId: 'example.attachdeleg-channels' }])(
        'persists $triageId entry through delegated send and rejoins without preparing twice', async identities => {
        const { triageId } = identities;
        const subject = await fixture(false, identities);
        try {
            const result = await subject.invoke(triageId, 'delegate');
            expect(result, JSON.stringify({ result, callers: subject.callers, preparedBy: subject.preparedBy }))
                .toMatchObject({ status: 'executed', value: { status: 'accepted' } });
            expect(subject.writes).toHaveLength(1);
            const content = subject.writes[0]!.content;
            expect(content).toMatchObject({ t: 'plain', v: { meta: {
                happierProvenanceV1: { pluginId: identities.channelsId },
            } } });
            expect(readAttachments(content)).toMatchObject([
                { attachment: { pluginId: triageId, localId: 'entry' } },
            ]);
            expect(await subject.invoke(triageId, 'delegate')).toMatchObject({ status: 'executed', value: { status: 'alreadyAccepted' } });
            expect(subject.writes[1]!.content).toEqual(content);
            expect(await subject.invoke(identities.channelsId, 'send')).toMatchObject({ status: 'executed',
                value: { status: 'rejected', code: 'session_input_invalid' } });
            expect(await subject.invoke(triageId, 'delegate', { localId: 'own' })).toMatchObject({ status: 'executed',
                value: { status: 'rejected', code: 'session_input_idempotency_conflict' } });
            expect(subject.writes).toHaveLength(2);
            expect(subject.preparedBy).toEqual([triageId]);
        } finally { await subject.dispose(); }
    });

    it('refuses a Triage-only entry without Triage as the immediate caller, including a grandparent', async () => {
        const subject = await fixture();
        try {
            for (const [pluginId, action] of [[channelsId, 'send'], [triageId, 'relay']] as const) {
                expect(await subject.invoke(pluginId, action)).toMatchObject({ status: 'executed',
                    value: { status: 'rejected', code: 'session_input_invalid' } });
            }
            expect(subject.writes).toEqual([]);
        } finally { await subject.dispose(); }
    });

    it('refuses authored qualification and caller claims before any persistence', async () => {
        const subject = await fixture();
        try {
            expect(await subject.invoke(channelsId, 'send', { forgeCaller: true })).toMatchObject({ status: 'executed',
                value: { status: 'rejected', code: 'session_input_invalid' } });
            expect(await subject.invoke(triageId, 'delegate', { localId: `${triageId}/entry` })).toMatchObject({ status: 'executed',
                value: { status: 'rejected', code: 'session_input_invalid' } });
            expect(subject.writes).toEqual([]);
        } finally { await subject.dispose(); }
    });

    it('preserves an own attachment and chooses the sender when both plugins declare the local id', async () => {
        const subject = await fixture(true);
        try {
            expect(await subject.invoke(channelsId, 'send', { localId: 'own', key: 'own-send' }))
                .toMatchObject({ status: 'executed', value: { status: 'accepted' } });
            expect(await subject.invoke(triageId, 'delegate')).toMatchObject({ status: 'executed', value: { status: 'accepted' } });
            expect(subject.preparedBy).toEqual([channelsId, channelsId]);
            for (const request of subject.writes) {
                expect(readAttachments(request.content)?.[0]?.attachment.pluginId)
                    .toBe(channelsId);
            }
        } finally { await subject.dispose(); }
    });
});
