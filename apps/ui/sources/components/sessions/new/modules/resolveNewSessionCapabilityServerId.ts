export function resolveNewSessionCapabilityServerId(params: Readonly<{
    targetServerId: string | null | undefined;
    activeServerId: string;
}>): string {
    const targetServerId = String(params.targetServerId ?? '').trim();
    if (targetServerId.length > 0) return targetServerId;
    return String(params.activeServerId ?? '').trim();
}
