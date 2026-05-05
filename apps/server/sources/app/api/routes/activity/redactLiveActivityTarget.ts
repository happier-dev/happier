type RedactableLiveActivityTarget = Readonly<{
    id: string;
    deviceId: string;
    serverId: string;
    sessionId: string;
    activityInstanceKey: string;
    activityId: string;
    activityName: string;
    transportMode: string;
    bundleId: string | null;
    environment: string | null;
    tokenKind: string;
    rawTokenEncrypted: Uint8Array | null;
    expoPushToken: string | null;
    clientServerUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
    endedAt: Date | null;
    lastPushedAt: Date | null;
    failureCount: number;
    lastFailureCode: string | null;
}>;

export function redactLiveActivityTarget(target: RedactableLiveActivityTarget) {
    return {
        id: target.id,
        deviceId: target.deviceId,
        serverId: target.serverId,
        sessionId: target.sessionId,
        activityInstanceKey: target.activityInstanceKey,
        activityId: target.activityId,
        activityName: target.activityName,
        transportMode: target.transportMode,
        bundleId: target.bundleId,
        environment: target.environment,
        tokenKind: target.tokenKind,
        hasRawToken: Boolean(target.rawTokenEncrypted),
        hasExpoPushToken: Boolean(target.expoPushToken),
        clientServerUrl: target.clientServerUrl,
        createdAt: target.createdAt.getTime(),
        updatedAt: target.updatedAt.getTime(),
        endedAt: target.endedAt?.getTime() ?? null,
        lastPushedAt: target.lastPushedAt?.getTime() ?? null,
        failureCount: target.failureCount,
        lastFailureCode: target.lastFailureCode,
    };
}
