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

    return { payloadText: nextPayloadText, nextWelcomedEpoch: null };
}
