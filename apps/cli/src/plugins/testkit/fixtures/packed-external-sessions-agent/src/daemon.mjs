/**
 * Packed External Sessions fixture daemon.
 *
 * This file is the packed fixture's executable daemon source. It is copied
 * into the archive by the production pack lifecycle — no built dist is
 * committed — so every proof below runs bytes produced from this source.
 *
 * The fixture declares the explicit Sessions read+control HostAccess grant in
 * its manifest and its background consumer issues all six public External
 * Sessions service calls (`capabilities`, `list`, `attach`, `readTranscript`,
 * `followTranscript`, `takeover`) through the host-supplied
 * `context.services.sessions.external`. Without the grant, production supplies
 * the unavailable service and every call observes the typed unavailable
 * rejection instead of a canonical service outcome.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ID = 'packed-external-agent';
const BACKGROUND_SERVICE_ID = 'packed-external-sessions-probe';

const probeOutputPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'packed-external-sessions-probe.json',
);

async function settle(promise) {
    try {
        const value = await promise;
        return { status: 'resolved', value };
    } catch (error) {
        return {
            status: 'rejected',
            code: error && typeof error === 'object' && 'code' in error
                ? error.code
                : null,
        };
    }
}

const externalSessions = Object.freeze({
    async resolveSource(request) {
        return { ok: true, value: { source: request.source } };
    },
    async listCandidates(request) {
        const items = [
            {
                remoteSessionId: 'packed-session-1',
                title: 'Packed external session 1',
                updatedAtMs: 1,
                linkData: { store: 'packed-fixture' },
            },
            {
                remoteSessionId: 'packed-session-2',
                title: 'Packed external session 2',
                updatedAtMs: 2,
                linkData: { store: 'packed-fixture' },
            },
        ];
        const start = request.cursor ? Number(request.cursor) : 0;
        const page = items.slice(start, start + (request.maxItems ?? items.length));
        return {
            ok: true,
            value: {
                candidates: page,
                nextCursor: start + page.length < items.length
                    ? String(start + page.length)
                    : null,
            },
        };
    },
    async resolveLinkIdentity(request) {
        return {
            ok: true,
            value: {
                source: request.source,
                remoteSessionId: request.remoteSessionId,
                linkData: { store: 'packed-fixture', linked: true },
            },
        };
    },
    async resolveLinkedIdentity(request) {
        return {
            ok: true,
            value: {
                source: request.source,
                remoteSessionId: request.remoteSessionId,
                linkData: request.linkData,
            },
        };
    },
    async pageTranscript(request) {
        const items = [
            {
                id: 'packed-item-1',
                createdAtMs: 1,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: AGENT_ID,
                        data: { type: 'message', message: 'Packed transcript one.' },
                    },
                },
            },
            {
                id: 'packed-item-2',
                createdAtMs: 2,
                messageRole: 'user',
                userProjection: 'source_fact',
                raw: {
                    role: 'user',
                    content: { type: 'text', text: 'Summarize what you found.' },
                },
            },
        ].slice(0, request.maxItems ?? 2);
        return {
            ok: true,
            value: { items, nextCursor: null },
        };
    },
    async readAfterTranscript() {
        return { ok: true, value: { outcome: 'already_current' } };
    },
});

export function activate(api) {
    api.agents.registerExternalSessions(AGENT_ID, externalSessions);
    api.backgroundServices.register(
        BACKGROUND_SERVICE_ID,
        async (context) => {
            const external = context.services.sessions.external;
            const results = {
                // Every public call is issued in a fixed order with its typed
                // outcome recorded, so the probe distinguishes an authorized
                // Sessions service (canonical outcomes or canonical typed
                // failures) from the unavailable service supplied without the
                // manifest grant (`plugin_services_current_global_unavailable`).
                capabilities: await settle(external.capabilities()),
                list: await settle(external.list({ agentId: AGENT_ID, limit: 1 })),
                attach: await settle(external.attach({
                    agentId: AGENT_ID,
                    source: { kind: 'packedFixtureStore', scope: 'primary' },
                    remoteSessionId: 'packed-session-1',
                })),
                readTranscript: await settle(external.readTranscript({
                    agentId: AGENT_ID,
                    source: { kind: 'packedFixtureStore', scope: 'primary' },
                    remoteSessionId: 'packed-session-1',
                    query: { direction: 'older', maxItems: 2 },
                })),
                followTranscript: await settle((async () => {
                    const following = await external.followTranscript(
                        {
                            agentId: AGENT_ID,
                            source: { kind: 'packedFixtureStore', scope: 'primary' },
                            remoteSessionId: 'packed-session-1',
                        },
                        {},
                        async () => {},
                    );
                    if (following.status === 'following') {
                        await following.subscription.dispose();
                    }
                    return following;
                })()),
                takeover: await settle(external.takeover(
                    {
                        agentId: AGENT_ID,
                        source: { kind: 'packedFixtureStore', scope: 'primary' },
                        remoteSessionId: 'packed-session-1',
                    },
                    {
                        targetStorageMode: 'external-linked',
                        idempotencyKey: 'packed-fixture-takeover-1',
                    },
                )),
            };
            await writeFile(probeOutputPath, JSON.stringify(results), 'utf8');
        },
    );
}
