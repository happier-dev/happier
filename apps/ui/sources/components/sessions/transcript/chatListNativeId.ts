export function buildChatListNativeId(sessionId: string, reactId: string): string {
    const safeSessionId = String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').trim() || 'unknown';
    const safeReactId = String(reactId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    const suffix = safeReactId || 'instance';
    return `ChatList.${safeSessionId}.${suffix}`;
}
