import React from 'react';
import { Platform } from 'react-native';

import type { DaemonPluginStructuredMessageResolveResponse, PluginJsonValueV2 } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { PluginUiProjectionModel, PluginUiStructuredMessageProjection } from '@/sync/domains/plugins/ui/projection';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { Text } from '@/components/ui/text/Text';
import {
    machinePluginStructuredMessageActionExecute,
    machinePluginStructuredMessageResolve,
} from '@/sync/ops/machineContributionRegistryProjection';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import {
    deriveTranscriptInteraction,
    type TranscriptInteraction,
} from '@/utils/sessions/deriveTranscriptInteraction';

import { DeclarativeStructuredMessageRenderer } from './DeclarativeStructuredMessageRenderer';
import { parseHappierMetaEnvelope, type HappierMetaEnvelope } from './happierMetaEnvelope';
import type { StructuredMessageRendererParams } from './structuredMessageRegistry';
import {
    findBuiltInStructuredMessageEntry,
    findPluginStructuredMessageDescriptor,
} from './descriptorRegistry';

const NON_STRUCTURED_HAPPIER_META_KINDS = new Set([
    'attachments.v1',
    'session_media.v1',
]);
const FAIL_CLOSED_STRUCTURED_MESSAGE_INTERACTION = deriveTranscriptInteraction({ kind: 'public' });

type SuccessfulResolution = Extract<DaemonPluginStructuredMessageResolveResponse, { ok: true }>;

function renderDescriptorFallback(descriptor: PluginUiStructuredMessageProjection): React.ReactElement | null {
    if (descriptor.fallback.kind === 'hidden') return null;
    return <Text testID="structured-message-summary-fallback">{descriptor.fallback.template}</Text>;
}

function PluginStructuredMessage(props: Readonly<{
    descriptor: PluginUiStructuredMessageProjection;
    envelope: HappierMetaEnvelope;
    generation: number | null;
    sessionId: string;
    messageId?: string;
    interaction: TranscriptInteraction;
}>): React.ReactElement | null {
    const [resolution, setResolution] = React.useState<SuccessfulResolution | null>(null);
    const [actionPending, setActionPending] = React.useState(false);
    const actionPendingRef = React.useRef(false);
    const canSendMessagesRef = React.useRef(props.interaction.canSendMessages === true);

    React.useLayoutEffect(() => {
        canSendMessagesRef.current = props.interaction.canSendMessages === true;
    }, [props.interaction.canSendMessages]);

    const handleAction = React.useCallback((action: Readonly<{ qualifiedId: string; input?: unknown }>) => {
        if (!canSendMessagesRef.current || !resolution || actionPendingRef.current) return;
        const machineId = readMachineControlTargetForSession(props.sessionId)?.machineId ?? '';
        if (!machineId) return;
        actionPendingRef.current = true;
        setActionPending(true);
        void machinePluginStructuredMessageActionExecute(machineId, {
            serverId: resolveServerIdForSessionIdFromLocalCache(props.sessionId),
            expectedGeneration: resolution.model.identity.generation,
            qualifiedActionId: action.qualifiedId,
            input: (action.input ?? null) as PluginJsonValueV2,
            sessionId: props.sessionId,
            executionSurface: 'ui',
        }).then((result) => {
            if (!result.supported || !result.result.ok) {
                setResolution((current) => current === resolution ? null : current);
            }
        }).finally(() => {
            actionPendingRef.current = false;
            setActionPending(false);
        });
    }, [props.sessionId, resolution]);

    React.useEffect(() => {
        let current = true;
        const abortController = new AbortController();
        setResolution(null);
        const machineId = readMachineControlTargetForSession(props.sessionId)?.machineId ?? '';
        if (!machineId || props.generation === null) return () => {
            current = false;
            abortController.abort();
        };
        void machinePluginStructuredMessageResolve(machineId, {
            serverId: resolveServerIdForSessionIdFromLocalCache(props.sessionId),
            expectedGeneration: String(props.generation),
            kind: props.envelope.kind,
            payload: props.envelope.payload as PluginJsonValueV2,
            ...(props.envelope.resources ? { resourceRefs: props.envelope.resources } : {}),
            facts: {
                'plugin.enabled': true,
                'session.exists': true,
                'host.platform': Platform.OS === 'web' ? 'web' : Platform.OS,
            },
            signal: abortController.signal,
        }).then((result) => {
            if (!current) return;
            if (result.supported && result.resolution.ok
                && result.resolution.model.visible
                && result.resolution.renderer.visible) {
                setResolution(result.resolution);
            }
        });
        return () => {
            current = false;
            abortController.abort();
        };
    }, [
        props.descriptor.id,
        props.envelope.kind,
        props.envelope.payload,
        props.envelope.resources,
        props.generation,
        props.messageId,
        props.sessionId,
    ]);

    return resolution
        ? <DeclarativeStructuredMessageRenderer
            resolution={resolution}
            onAction={props.interaction.canSendMessages === true ? handleAction : undefined}
            actionPending={actionPending}
        />
        : renderDescriptorFallback(props.descriptor);
}

export function renderStructuredMessage(params: {
    message: Message;
    sessionId: string;
    interaction: TranscriptInteraction;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    pluginUiProjection?: PluginUiProjectionModel | null;
}): React.ReactElement | null {
    const envelope = parseHappierMetaEnvelope(params.message.meta);
    if (!envelope) return null;
    if (NON_STRUCTURED_HAPPIER_META_KINDS.has(envelope.kind)) return null;

    const builtIn = findBuiltInStructuredMessageEntry(envelope.kind);
    if (builtIn) {
        const parsed = builtIn.schema.safeParse(envelope.payload);
        return parsed.success
            ? builtIn.render(parsed.data, {
                sessionId: params.sessionId,
                message: params.message,
                interaction: params.interaction,
                onJumpToAnchor: params.onJumpToAnchor,
            })
            : <PluginSurfaceFallback testID="structured-message-unavailable" />;
    }

    const descriptor = findPluginStructuredMessageDescriptor({
        kind: envelope.kind,
        pluginUiProjection: params.pluginUiProjection,
    });
    if (!descriptor) {
        return <PluginSurfaceFallback testID="structured-message-unavailable" />;
    }
    return (
        <PluginStructuredMessage
            descriptor={descriptor}
            envelope={envelope}
            generation={params.pluginUiProjection?.generation ?? null}
            sessionId={params.sessionId}
            messageId={'id' in params.message ? String(params.message.id ?? '') : undefined}
            interaction={params.interaction}
        />
    );
}

export const StructuredMessageBlock = React.memo(function StructuredMessageBlock(props: {
    message: Message;
    sessionId: string;
    interaction?: TranscriptInteraction;
    onJumpToAnchor: StructuredMessageRendererParams['onJumpToAnchor'];
    pluginUiProjection?: PluginUiProjectionModel | null;
}): React.ReactElement | null {
    return renderStructuredMessage({
        ...props,
        interaction: props.interaction ?? FAIL_CLOSED_STRUCTURED_MESSAGE_INTERACTION,
    });
});
