/** Voice speech and local notes share event time, independent of server arrival sequence. */
export function compareVoiceTranscriptOrder(
    left: Readonly<{ createdAt: number; id: string }>,
    right: Readonly<{ createdAt: number; id: string }>,
): number {
    return left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt - right.createdAt;
}
