export function createClaudeAgentSdkCheckpointLedger() {
    let lastCheckpointId: string | null = null;
    const checkpointIds: string[] = [];
    const checkpointIdSet = new Set<string>();

    const recordCheckpointId = (id: string) => {
        if (checkpointIdSet.has(id)) return;
        checkpointIdSet.add(id);
        checkpointIds.push(id);
    };

    const captureUserTextCheckpoint = (params: {
        enabled: boolean;
        isUserTextMessage: boolean;
        uuid: string | null;
        onCheckpointCaptured?: ((checkpointId: string) => void) | undefined;
    }) => {
        if (!params.enabled || !params.isUserTextMessage) return;
        if (!params.uuid || params.uuid === lastCheckpointId) return;
        lastCheckpointId = params.uuid;
        recordCheckpointId(params.uuid);
        params.onCheckpointCaptured?.(params.uuid);
    };

    return {
        captureUserTextCheckpoint,
        getLastCheckpointId: () => lastCheckpointId,
        getCheckpointIds: () => checkpointIds.slice(),
        recordCheckpointId,
    };
}
