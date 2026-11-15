import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { SESSION_SPAWN_NEW_ACTION_ID_V1, SESSION_OPEN_ACTION_ID_V1, SESSION_MESSAGE_SEND_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { SessionSpawnNewInitialInputV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ComposerAttachmentInputV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createDemoListSession } from '../world/sessions';
import { DEMO_NOW_MS, DEMO_PROJECT_PATH } from '../world/constants';
import { registerDemoSessionForRestore } from '../seed/seedDemoWorld';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/** The existing demo world's substituted daemon Session transport, with real store effects. */
export function createDemoPluginSessionTransport(input: Readonly<{
    pluginId: string;
    attachmentTypeLabel: string;
    lifetime: ActiveServerAccountScopeLifetime;
    openSession(sessionId: string): Promise<void>;
}>) {
    const creations = new Map<string, string>();
    const deliveries = new Map<string, string>();
    input.lifetime.onRetire(() => { creations.clear(); deliveries.clear(); });
    function acceptInput(sessionId: string, initial: SessionSpawnNewInitialInputV1): string {
        const localId = crypto.randomUUID();
        const authored = initial.attachments?.map(attachment => ComposerAttachmentInputV1Schema.parse({
            v: 1, instanceId: crypto.randomUUID(), attachment: { pluginId: input.pluginId, localId: attachment.attachmentLocalId }, ...attachment.value,
            presentation: { ...attachment.value.presentation, typeLabel: input.attachmentTypeLabel },
        }));
        const structured = initial.structuredInput || authored?.length ? HappierStructuredInputV1Schema.parse({
            ...initial.structuredInput, v: 1,
            composerAttachments: [...(initial.structuredInput?.composerAttachments ?? []), ...(authored ?? [])],
        }) : undefined;
        const session = storage.getState().sessions[sessionId];
        storage.getState().applyMessages(sessionId, [{ id: crypto.randomUUID(), localId, seq: (session.seq ?? 0) + 1,
            createdAt: DEMO_NOW_MS, isSidechain: false, role: 'user', content: { type: 'text', text: initial.text ?? '' },
            ...(structured ? { meta: { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: structured } } : {}) }]);
        return localId;
    }
    return async (action: string, value: JsonValue | undefined): Promise<unknown> => {
        if (!input.lifetime.isCurrent()) throw new PluginError({ code: 'stale_surface' });
        if (action === SESSION_SPAWN_NEW_ACTION_ID_V1) {
            const spawn = PLUGIN_ACTION_INPUT_SCHEMAS[SESSION_SPAWN_NEW_ACTION_ID_V1].parse(value);
            if (spawn.executionTarget.serverId !== input.lifetime.scope.serverId) throw new PluginError({ code: 'unavailable' });
            const previous = spawn.creationKey ? creations.get(spawn.creationKey) : undefined;
            const sessionId = previous ?? crypto.randomUUID();
            if (previous === undefined) {
                const session = { ...createDemoListSession({ id: sessionId, machineId: spawn.executionTarget.machineId,
                    title: spawn.title ?? 'New Session', path: spawn.directory.kind === 'path' ? spawn.directory.path : DEMO_PROJECT_PATH,
                    active: true, activeAt: DEMO_NOW_MS, seq: 0,
                    flavor: spawn.agentTarget.kind === 'agent' ? spawn.agentTarget.identity.localId : undefined }),
                    serverId: input.lifetime.scope.serverId };
                registerDemoSessionForRestore(sessionId);
                const state = storage.getState();
                state.applySessions([session]);
                state.applyServerScopedSessionListRows(input.lifetime.scope.serverId, [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
                state.applyMessagesLoaded(sessionId);
                state.markSessionMessagesHistoryStartLoaded(sessionId);
                if (spawn.creationKey) creations.set(spawn.creationKey, sessionId);
            }
            return SessionSpawnNewActionResultV1Schema.parse({ type: 'success', disposition: previous ? 'rejoined' : 'created', sessionId,
                executionTarget: spawn.executionTarget, organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } });
        }
        if (action === SESSION_MESSAGE_SEND_ACTION_ID_V1) {
            const request = PLUGIN_ACTION_INPUT_SCHEMAS[SESSION_MESSAGE_SEND_ACTION_ID_V1].parse(value);
            if (!('message' in request) || typeof request.sessionId !== 'string') throw new PluginError({ code: 'unavailable' });
            const session = storage.getState().sessions[request.sessionId];
            if (session?.serverId !== input.lifetime.scope.serverId) throw new PluginError({ code: 'unavailable' });
            const key = JSON.stringify([request.sessionId, request.idempotencyKey]);
            const previous = deliveries.get(key);
            if (previous) return { status: 'alreadyAccepted', localId: previous };
            const localId = acceptInput(request.sessionId, { text: request.message, attachments: request.attachments });
            deliveries.set(key, localId);
            return { status: 'accepted', localId };
        }
        if (action === SESSION_OPEN_ACTION_ID_V1) {
            const request = PLUGIN_ACTION_INPUT_SCHEMAS[SESSION_OPEN_ACTION_ID_V1].parse(value);
            if (typeof request.sessionId !== 'string') throw new PluginError({ code: 'unavailable' });
            await input.openSession(request.sessionId);
            return { ok: true };
        }
        throw new PluginError({ code: 'unavailable', message: 'This Session Action has no demo transport.' });
    };
}
