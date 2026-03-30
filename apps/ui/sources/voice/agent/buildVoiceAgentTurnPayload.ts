import { storage } from '@/sync/domains/state/storage';

export function buildVoiceAgentTurnPayload(params: Readonly<{
    sessionId: string;
    userText: string;
    pendingContext: readonly string[];
    lastWelcomedEpoch: number | undefined;
}>): Readonly<{
    payloadText: string;
    nextWelcomedEpoch: number | null;
}> {
    let nextPayloadText = params.userText;
    if (params.pendingContext.length > 0) {
        nextPayloadText =
            `Context updates since your last voice turn:\n\n${params.pendingContext.join('\n\n---\n\n')}\n\nUser said:\n${params.userText}`;
    }

    const settings: any = storage.getState().settings;
    const agentCfg = settings?.voice?.adapters?.local_conversation?.agent ?? null;
    const welcomeCfg = agentCfg?.welcome ?? null;
    const welcomeEnabled = welcomeCfg?.enabled === true;
    const welcomeMode = welcomeCfg?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
    if (welcomeEnabled && (welcomeMode === 'on_first_turn' || welcomeMode === 'immediate')) {
        const epochRaw = Number(agentCfg?.transcript?.epoch ?? 0);
        const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
        if (params.lastWelcomedEpoch !== epoch) {
            nextPayloadText = [
                'At the start of your reply, include a short friendly greeting (one sentence).',
                'Then continue with your response.',
                '',
                nextPayloadText,
            ].join('\n');
            return { payloadText: nextPayloadText, nextWelcomedEpoch: epoch };
        }
    }

    return { payloadText: nextPayloadText, nextWelcomedEpoch: null };
}
