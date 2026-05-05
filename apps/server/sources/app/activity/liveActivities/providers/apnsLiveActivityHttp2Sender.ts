import { connect, type ClientHttp2Session } from "node:http2";

import { parseIntEnv } from "@/config/env";

export type ApnsLiveActivityHttp2Request = Readonly<{
    endpoint: string;
    deviceToken: string;
    headers: Readonly<Record<string, string>>;
    payload: unknown;
    timeoutMs?: number;
}>;

export type ApnsLiveActivityHttp2Response = Readonly<{
    status: number;
    reason?: string;
    apnsId?: string;
}>;

const sessions = new Map<string, ClientHttp2Session>();
const reconnectBackoffUntilMsBySessionKey = new Map<string, number>();
const DEFAULT_APNS_LIVE_ACTIVITY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_APNS_LIVE_ACTIVITY_RECONNECT_BACKOFF_MS = 1_000;

function buildSessionKey(params: Pick<ApnsLiveActivityHttp2Request, "endpoint" | "headers">): string {
    return `${params.endpoint}\0${params.headers["apns-topic"] ?? ""}`;
}

function reconnectBackoffMs(): number {
    return parseIntEnv(
        process.env.HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS,
        DEFAULT_APNS_LIVE_ACTIVITY_RECONNECT_BACKOFF_MS,
        { min: 1 },
    );
}

function rememberReconnectBackoff(sessionKey: string): void {
    reconnectBackoffUntilMsBySessionKey.set(sessionKey, Date.now() + reconnectBackoffMs());
}

function getSession(endpoint: string, sessionKey: string): ClientHttp2Session {
    const existing = sessions.get(sessionKey);
    if (existing && !existing.destroyed && !existing.closed) {
        return existing;
    }
    const backoffUntilMs = reconnectBackoffUntilMsBySessionKey.get(sessionKey);
    if (backoffUntilMs !== undefined) {
        if (Date.now() < backoffUntilMs) {
            throw new Error("APNs Live Activity HTTP/2 session is in reconnect backoff");
        }
        reconnectBackoffUntilMsBySessionKey.delete(sessionKey);
    }

    const session = connect(endpoint);
    session.once("close", () => {
        sessions.delete(sessionKey);
        rememberReconnectBackoff(sessionKey);
    });
    session.once("error", () => {
        sessions.delete(sessionKey);
        rememberReconnectBackoff(sessionKey);
    });
    sessions.set(sessionKey, session);
    return session;
}

function parseApnsReason(body: string): string | undefined {
    if (!body) return undefined;
    try {
        const parsed = JSON.parse(body) as { reason?: unknown };
        return typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason : undefined;
    } catch {
        return undefined;
    }
}

export function sendApnsLiveActivityHttp2Request(
    params: ApnsLiveActivityHttp2Request,
): Promise<ApnsLiveActivityHttp2Response> {
    return new Promise((resolve, reject) => {
        const session = getSession(params.endpoint, buildSessionKey(params));
        const request = session.request({
            ":method": "POST",
            ":path": `/3/device/${params.deviceToken}`,
            ...params.headers,
        });
        let status = 0;
        let apnsId: string | undefined;
        const chunks: Buffer[] = [];
        const timeoutMs = params.timeoutMs ?? parseIntEnv(
            process.env.HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS,
            DEFAULT_APNS_LIVE_ACTIVITY_REQUEST_TIMEOUT_MS,
            { min: 1 },
        );
        let settled = false;
        const timeout = setTimeout(() => {
            request.close();
            settle(reject, new Error("APNs Live Activity request timed out"));
        }, timeoutMs);

        function settle<T>(complete: (value: T) => void, value: T): void {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            complete(value);
        }

        request.setEncoding("utf8");
        request.on("response", (headers) => {
            const rawStatus = headers[":status"];
            status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
            const rawApnsId = headers["apns-id"];
            apnsId = Array.isArray(rawApnsId) ? rawApnsId[0] : rawApnsId;
        });
        request.on("data", (chunk: string | Buffer) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
            settle(resolve, {
                status,
                reason: parseApnsReason(Buffer.concat(chunks).toString("utf8")),
                apnsId,
            });
        });
        request.on("error", (error) => settle(reject, error));
        request.end(JSON.stringify(params.payload));
    });
}
