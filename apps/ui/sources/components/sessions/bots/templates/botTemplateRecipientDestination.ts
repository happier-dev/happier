import { BotTemplateReleaseSourceV1Schema, BotTemplateSourceSessionRefV1Schema, type BotTemplateReleaseSourceV1,
    type BotTemplateSourceSessionRefV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

/** Carries only the portable release address; opening material never belongs in route state. */
export function buildBotTemplateRecipientRoute(source: BotTemplateReleaseSourceV1, serverId: string, sessionRef?: BotTemplateSourceSessionRefV1) {
    return { pathname: '/bot-template' as const, params: { source: JSON.stringify(source), serverId,
        ...(sessionRef ? { sessionRef: JSON.stringify(sessionRef) } : {}) } };
}

export function readBotTemplateRecipientRoute(params: Readonly<{ source?: string | string[]; serverId?: string | string[]; sessionRef?: string | string[] }>) {
    if (typeof params.source !== 'string' || typeof params.serverId !== 'string' || !params.serverId.trim()) return null;
    try {
        const parsed = BotTemplateReleaseSourceV1Schema.safeParse(JSON.parse(params.source));
        if (!parsed.success) return null;
        if (params.sessionRef === undefined) return { source: parsed.data, serverId: params.serverId };
        if (typeof params.sessionRef !== 'string') return null;
        const session = BotTemplateSourceSessionRefV1Schema.safeParse(JSON.parse(params.sessionRef));
        return session.success ? { source: parsed.data, serverId: params.serverId, sessionRef: session.data } : null;
    } catch { return null; }
}
