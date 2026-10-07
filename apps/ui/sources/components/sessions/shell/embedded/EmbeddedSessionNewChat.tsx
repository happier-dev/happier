import * as React from 'react';
import { createProviderErrorV1, ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol/sessions/creation/sessionDirectoryIntentV1';

import { NewSessionScreen } from '@/components/sessions/new/NewSessionScreen';
import {
    mergeNewSessionHostParams,
    NewSessionEmbeddedHostProvider,
    type NewSessionCreationProfile,
    type NewSessionEmbeddedHost,
    type NewSessionHostParams,
} from '@/components/sessions/new/navigation/newSessionHost';
import type { SessionSpawnNewActionExecutor } from '@/sync/ops/actions/sessionSpawnNewAction';

import { EmbeddedNewChatWelcome } from './EmbeddedNewChatWelcome';
import { EmbeddedSessionPartClaimsScope, EmbeddedSessionPartsProvider, EmbeddedSessionStandardLayout, type EmbeddedSessionPartsValue } from './EmbeddedSessionParts';
import type { EmbeddedNewSessionCreated, EmbeddedSessionNewChatTarget } from './embeddedSessionTarget';

const MANAGED_DIRECTORY: SessionDirectoryIntentV1 = Object.freeze({ kind: 'managed' });
const noop = () => undefined;
const NEW_CHAT_WELCOME = <EmbeddedNewChatWelcome />;

/**
 * The presentation host's `onCreate` as the New Session flow's one spawn step. The flow keeps its
 * launch attempt, custody and retry; this only adapts the host's answer to the spawn settlement
 * the flow already understands.
 */
export function createEmbeddedNewChatSpawnExecutor(input: Readonly<{
    readOnCreate: () => EmbeddedSessionNewChatTarget['onCreate'];
    onSpawned: (sessionId: string) => void;
}>): SessionSpawnNewActionExecutor {
    return async (spawnInput, context) => {
        let created: EmbeddedNewSessionCreated;
        try {
            created = await input.readOnCreate()(spawnInput, { attemptId: context.actionRequestId ?? '' });
        } catch (error) {
            // The host could not say whether its spawn landed. A retryable failure keeps this launch
            // attempt, so Retry asks again with the same identity and never creates a second Session.
            // Retryability is typed: the host's own `retryable`, else the protocol's for its code
            // (a grant refusal such as `model_not_granted` never succeeds on retry).
            const failure = error !== null && typeof error === 'object' ? error : null;
            const code = failure && 'code' in failure ? failure.code : error instanceof Error ? error.message : null;
            const typedRetryable = failure && 'retryable' in failure && typeof failure.retryable === 'boolean' ? failure.retryable : null;
            const providerCode = ProviderErrorCodeV1Schema.safeParse(code);
            const definitive = typedRetryable !== null
                ? !typedRetryable
                : providerCode.success && !createProviderErrorV1(providerCode.data).retryable;
            const settlement = SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code, retryable: !definitive });
            return { ok: true, result: settlement.success ? settlement.data
                : { type: 'error', code: definitive ? 'permission_denied' : 'spawn_failed', retryable: !definitive } };
        }
        input.onSpawned(created.sessionId);
        return {
            ok: true,
            result: {
                type: 'success',
                disposition: 'created',
                sessionId: created.sessionId,
                executionTarget: spawnInput.executionTarget,
                organizationPlacement: spawnInput.organizationPlacement ?? { folderId: null, tagIds: [] },
                // The canonical afterCreated sender admits the first turn when the host did not.
                initialInput: created.initialInput ?? { status: 'notRequested' },
            },
        };
    };
}

/**
 * The embedded new-chat arm (plan 05 §4.3.5, R-CREATE): the app's real New Session composer — the
 * same screen model, composer, launch attempt, retry and draft settlement — with the presentation
 * host's creation profile applied and its `onCreate` as the one spawn step. On success the
 * provider continues on the created Session in place; nothing navigates.
 */
export function EmbeddedSessionNewChat(props: Readonly<{
    target: EmbeddedSessionNewChatTarget;
    serverId: string | null;
    arrangement?: React.ReactNode;
    onCreated: (sessionId: string) => void;
}>) {
    const targetRef = React.useRef(props.target);
    targetRef.current = props.target;
    const onCreatedRef = React.useRef(props.onCreated);
    onCreatedRef.current = props.onCreated;
    const createdSessionIdRef = React.useRef<string | null>(null);
    const creation = props.target.creation;
    const [params, setParamsState] = React.useState<NewSessionHostParams>(() => ({
        // One draft per new chat: the composer's text survives remounts of this surface, and the
        // attempt identity the flow derives from it is what a retried spawn reuses.
        draftId: creation.draftId,
        ...(creation.machineId ? { machineId: creation.machineId } : {}),
        ...(creation.agentTargetKey ? { backendTargetKey: creation.agentTargetKey } : {}),
        ...(props.serverId ? { spawnServerId: props.serverId } : {}),
    }));
    const setParams = React.useCallback((patch: Readonly<Record<string, unknown>>) => {
        setParamsState((current) => mergeNewSessionHostParams(current, patch));
    }, []);
    const executeSpawnAction = React.useMemo(() => createEmbeddedNewChatSpawnExecutor({
        readOnCreate: () => targetRef.current.onCreate,
        onSpawned: (sessionId) => { createdSessionIdRef.current = sessionId; },
    }), []);
    const onHandedOff = React.useCallback(() => {
        const sessionId = createdSessionIdRef.current;
        if (sessionId) onCreatedRef.current(sessionId);
    }, []);
    const creationProfile = React.useMemo<NewSessionCreationProfile>(() => ({
        hostBindsMachine: true,
        ...(creation.draftScope ? { draftScope: creation.draftScope } : {}),
        ...(creation.machineId ? { machineId: creation.machineId } : {}),
        ...(creation.agentTargetKey ? { agentTargetKey: creation.agentTargetKey } : {}),
        ...(creation.allowedModels !== undefined ? { allowedModels: creation.allowedModels } : {}),
        ...(creation.modelCatalog !== undefined ? { modelCatalog: creation.modelCatalog } : {}),
        ...(creation.permissionModes !== undefined ? { permissionModes: creation.permissionModes } : {}),
        ...(creation.attachments !== undefined ? { attachments: creation.attachments } : {}),
    }), [creation.draftScope, creation.machineId, creation.agentTargetKey, creation.allowedModels, creation.modelCatalog, creation.attachments, creation.permissionModes]);
    const host = React.useMemo<NewSessionEmbeddedHost>(() => ({
        params,
        setParams,
        // A new chat is one draft; it never opens another in its place.
        openDraft: noop,
        onHandedOff,
        demanded: true,
        executeSpawnAction,
        createdSessionPresentation: 'inPlace',
        creationProfile,
    }), [creationProfile, executeSpawnAction, onHandedOff, params, setParams]);

    const composer = React.useMemo(() => (
        <NewSessionEmbeddedHostProvider host={host}>
            <NewSessionScreen presentation="embedded" fixedDirectoryIntent={MANAGED_DIRECTORY} />
        </NewSessionEmbeddedHostProvider>
    ), [host]);
    const parts = React.useMemo<EmbeddedSessionPartsValue>(() => ({
        // Nothing has been said yet: one quiet line sits over the empty transcript region.
        transcript: null,
        placeholder: NEW_CHAT_WELCOME,
        composer,
        state: 'ready',
        chatBottomSpacing: 'none',
    }), [composer]);
    return (
        <EmbeddedSessionPartClaimsScope>
            <EmbeddedSessionPartsProvider value={parts}>
                {props.arrangement ?? <EmbeddedSessionStandardLayout />}
            </EmbeddedSessionPartsProvider>
        </EmbeddedSessionPartClaimsScope>
    );
}
