import { createHmac } from 'node:crypto';

import {
    ExternalSessionTranscriptRefreshBindingV1Schema,
    type ExternalSessionTranscriptRefreshBindingV1,
} from '@happier-dev/protocol';

import { resolveExternalSessionObservationLinkInput } from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readCredentials } from '@/persistence';

type ExternalSessionTranscriptRefreshAuthority = Omit<
    ExternalSessionTranscriptRefreshBindingV1,
    'v' | 'cursorIdentity'
>;

export function deriveExternalSessionTranscriptRefreshCursorIdentity(params: Readonly<{
    key: Uint8Array;
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
        authority.contributionGeneration,
        params.cursor,
    ]);
    return `external_session_cursor_binding_v1:${
        createHmac('sha256', params.key).update(commitment, 'utf8').digest('hex')
    }`;
}

export async function resolveExternalSessionTranscriptRefreshBinding(params: Readonly<{
    sessionId: string;
    cursor: string;
}>): Promise<ExternalSessionTranscriptRefreshBindingV1 | null> {
    const credentials = await readCredentials().catch(() => null);
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
        contributionGeneration: observation.resource.pluginGeneration,
    };
    const key = credentials.encryption.type === 'legacy'
        ? credentials.encryption.secret
        : credentials.encryption.machineKey;

    return ExternalSessionTranscriptRefreshBindingV1Schema.parse({
        v: 1,
        ...authority,
        cursorIdentity: deriveExternalSessionTranscriptRefreshCursorIdentity({
            key,
            cursor: params.cursor,
            authority,
        }),
    });
}
