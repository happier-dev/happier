import { ExternalSessionTranscriptRefreshBindingV1Schema } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import type { ExternalSessionTranscriptRefreshBindingV1 } from '@happier-dev/protocol';

import { resolveExternalSessionObservationLinkInput } from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { readStoredCredentials } from '@/persistence';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

type ExternalSessionTranscriptRefreshAuthority = Omit<
    ExternalSessionTranscriptRefreshBindingV1,
    'v' | 'cursorIdentity'
>;

export function deriveExternalSessionTranscriptRefreshCursorIdentity(params: Readonly<{
    deviceLocalSecretStorage: DeviceLocalSecretStorage;
    cursor: string;
    authority: ExternalSessionTranscriptRefreshAuthority;
}>): string {
    const { authority } = params;
    const commitment = JSON.stringify([
        'external_session_cursor_binding_v1',
        authority.machineId,
        authority.sessionId,
        authority.link.generation,
        authority.link.remoteSessionId,
        authority.source.qualifiedIdentity.v,
        authority.source.qualifiedIdentity.agent.pluginId,
        authority.source.qualifiedIdentity.agent.localId,
        authority.source.qualifiedIdentity.source.kind,
        authority.source.qualifiedIdentity.source.contractVersion,
        authority.source.generation,
        JSON.stringify(authority.sourceCustody),
        params.cursor,
    ]);
    return `external_session_cursor_binding_v1:${
        params.deviceLocalSecretStorage.deriveOpaqueIdentity({
            purpose: 'external_session_transcript_refresh_cursor',
            value: commitment,
        })
    }`;
}

export async function resolveExternalSessionTranscriptRefreshCurrentness(params: Readonly<{
    sessionId: string;
    cursor: string;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
}>): Promise<Readonly<{
    binding: ExternalSessionTranscriptRefreshBindingV1;
    occurrenceId: PluginRuntimeOccurrenceId;
}> | null> {
    if (!params.deviceLocalSecretStorage) return null;
    const credentials = await readStoredCredentials().catch(() => null);
    if (!credentials) return null;
    const loaded = await loadLinkedExternalSession({
        credentials,
        sessionId: params.sessionId,
    }).catch(() => null);
    if (!loaded?.ok) return null;
    const observation = await resolveExternalSessionObservationLinkInput({
        linked: loaded.session,
        sessionId: params.sessionId,
    }).catch(() => null);
    if (!observation) return null;
    if (!observation.sourceCustody) return null;

    const authority: ExternalSessionTranscriptRefreshAuthority = {
        machineId: loaded.session.machineId,
        sessionId: params.sessionId,
        link: {
            generation: loaded.session.linkGeneration,
            remoteSessionId: loaded.session.remoteSessionId,
        },
        source: {
            qualifiedIdentity: observation.target.qualifiedLinkIdentity,
            generation: observation.resource.resourceKey,
        },
        sourceCustody: observation.sourceCustody,
    };
    const binding = ExternalSessionTranscriptRefreshBindingV1Schema.parse({
        v: 1,
        ...authority,
        cursorIdentity: deriveExternalSessionTranscriptRefreshCursorIdentity({
            deviceLocalSecretStorage: params.deviceLocalSecretStorage,
            cursor: params.cursor,
            authority,
        }),
    });
    return {
        binding,
        occurrenceId: observation.resource.occurrenceId as PluginRuntimeOccurrenceId,
    };
}

export async function resolveExternalSessionTranscriptRefreshBinding(params: Readonly<{
    sessionId: string;
    cursor: string;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
}>): Promise<ExternalSessionTranscriptRefreshBindingV1 | null> {
    return (await resolveExternalSessionTranscriptRefreshCurrentness(params))?.binding ?? null;
}
