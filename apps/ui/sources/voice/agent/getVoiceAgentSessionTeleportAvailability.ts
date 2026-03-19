import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export type VoiceAgentSessionTeleportAvailability =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        code: 'VOICE_TELEPORT_DISABLED' | 'VOICE_TELEPORT_BLOCKED_BY_HOME' | 'VOICE_TELEPORT_UNAVAILABLE';
    }>;

export function getVoiceAgentSessionTeleportAvailability(params: Readonly<{ voice: unknown; sessionId: string | null | undefined }>): VoiceAgentSessionTeleportAvailability {
    const sessionId = normalizeNonEmptyString(params.sessionId);
    if (!sessionId) return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

    const voice = params.voice as any;
    if (voice?.providerId !== 'local_conversation') return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

    const adapterCfg = voice?.adapters?.local_conversation ?? null;
    if (adapterCfg?.conversationMode !== 'agent') return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

    const agentCfg = adapterCfg?.agent ?? null;
    if (agentCfg?.stayInVoiceHome === true) return { ok: false, code: 'VOICE_TELEPORT_BLOCKED_BY_HOME' };
    if (agentCfg?.teleportEnabled === false) return { ok: false, code: 'VOICE_TELEPORT_DISABLED' };
    if ((agentCfg?.backend ?? 'daemon') !== 'daemon') return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

    return { ok: true };
}
