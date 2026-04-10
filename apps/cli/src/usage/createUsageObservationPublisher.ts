import axios from 'axios';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { normalizeBaseUrl } from '@/diagnostics/httpClient';

import {
    buildLegacyUsageReportFromUsageObservation,
    type UsageObservation,
    type UsageReportV1,
} from './usageObservation';
import { buildUsageEventIngestRequest } from './buildUsageEventIngestRequest';

type UsageObservationPublisherMode = 'unknown' | 'v2' | 'legacy';

type PostJsonResult = Readonly<{ ok: true }>;

function isUnsupportedHttpStatus(status: number | null | undefined): boolean {
    return status === 404 || status === 405 || status === 501;
}

function isAuthHttpStatus(status: number | null | undefined): boolean {
    return status === 401 || status === 403;
}

function extractErrorStatus(error: unknown): number | null {
    if (axios.isAxiosError(error)) {
        return typeof error.response?.status === 'number' ? error.response.status : null;
    }
    const response = typeof error === 'object' && error !== null ? (error as { response?: { status?: unknown } }).response : null;
    return typeof response?.status === 'number' ? response.status : null;
}

function resolveUsageAnalyticsIngestPath(snapshot: Extract<CliServerFeaturesSnapshot, { status: 'ready' }>): string | null {
    const path = snapshot.features.capabilities.server?.usageAnalytics?.eventsIngest.path;
    return typeof path === 'string' && path.trim().length > 0 ? path.trim() : null;
}

async function defaultPostJson(params: Readonly<{
    serverUrl: string;
    token: string;
    path: string;
    body: unknown;
}>): Promise<PostJsonResult> {
    await axios.post(
        `${normalizeBaseUrl(params.serverUrl)}${params.path}`,
        params.body,
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
        },
    );
    return { ok: true };
}

export function createUsageObservationPublisher(params: Readonly<{
    token: string;
    apiServerUrl: string;
    fetchServerFeaturesSnapshot?: typeof fetchServerFeaturesSnapshot;
    resolveToken?: () => Promise<string | null>;
    postJson?: (params: Readonly<{
        serverUrl: string;
        token: string;
        path: string;
        body: unknown;
    }>) => Promise<PostJsonResult>;
    emitLegacyUsageReport: (report: UsageReportV1) => void;
    onPublishError?: (error: unknown) => void;
}>) {
    let mode: UsageObservationPublisherMode = 'unknown';
    let ingestPath: string | null = null;
    let currentToken = params.token;

    async function resolveModeForPublish(): Promise<Readonly<{ mode: UsageObservationPublisherMode; path: string | null }>> {
        if (mode === 'v2' && ingestPath) {
            return { mode, path: ingestPath };
        }
        if (mode === 'legacy') {
            return { mode, path: null };
        }

        const snapshot = await (params.fetchServerFeaturesSnapshot ?? fetchServerFeaturesSnapshot)({
            serverUrl: params.apiServerUrl,
            timeoutMs: 1_500,
        });
        if (snapshot.status === 'ready') {
            const supportedPath = resolveUsageAnalyticsIngestPath(snapshot);
            if (supportedPath) {
                mode = 'v2';
                ingestPath = supportedPath;
                return { mode, path: supportedPath };
            }
            mode = 'legacy';
            ingestPath = null;
            return { mode, path: null };
        }

        if (snapshot.status === 'unsupported') {
            mode = 'legacy';
            ingestPath = null;
            return { mode, path: null };
        }

        return { mode: 'legacy', path: null };
    }

    function emitLegacyReport(params2: Readonly<{
        sessionId: string;
        observation: UsageObservation;
    }>): void {
        const report = buildLegacyUsageReportFromUsageObservation({
            sessionId: params2.sessionId,
            observation: params2.observation,
        });
        if (report) {
            params.emitLegacyUsageReport(report);
        }
    }

    return {
        async publish(input: Readonly<{
            sessionId: string;
            observation: UsageObservation;
            observedAt?: number;
            backendMode?: string | null;
            projectKey?: string | null;
            workspaceId?: string | null;
            machineId?: string | null;
            turnId?: string | null;
            externalKey?: string | null;
            metadata?: Record<string, unknown>;
        }>): Promise<void> {
            const publishMode = await resolveModeForPublish();
            if (publishMode.mode === 'v2' && publishMode.path) {
                const request = buildUsageEventIngestRequest({
                    sessionId: input.sessionId,
                    observedAt: input.observedAt ?? Date.now(),
                    observation: input.observation,
                    backendMode: input.backendMode,
                    projectKey: input.projectKey,
                    workspaceId: input.workspaceId,
                    machineId: input.machineId,
                    turnId: input.turnId,
                    externalKey: input.externalKey,
                    metadata: input.metadata,
                });
                if (!request) return;

                try {
                    await (params.postJson ?? defaultPostJson)({
                        serverUrl: params.apiServerUrl,
                        token: currentToken,
                        path: publishMode.path,
                        body: request,
                    });
                    return;
                } catch (error) {
                    const status = extractErrorStatus(error);
                    if (isUnsupportedHttpStatus(status)) {
                        mode = 'legacy';
                        ingestPath = null;
                        emitLegacyReport({
                            sessionId: input.sessionId,
                            observation: input.observation,
                        });
                        return;
                    }

                    if (isAuthHttpStatus(status)) {
                        const refreshedToken = (await params.resolveToken?.())?.trim() ?? null;
                        if (refreshedToken && refreshedToken.length > 0) {
                            currentToken = refreshedToken;
                            try {
                                await (params.postJson ?? defaultPostJson)({
                                    serverUrl: params.apiServerUrl,
                                    token: currentToken,
                                    path: publishMode.path,
                                    body: request,
                                });
                                return;
                            } catch (retryError) {
                                const retryStatus = extractErrorStatus(retryError);
                                if (isUnsupportedHttpStatus(retryStatus)) {
                                    mode = 'legacy';
                                    ingestPath = null;
                                    emitLegacyReport({
                                        sessionId: input.sessionId,
                                        observation: input.observation,
                                    });
                                    return;
                                }
                                emitLegacyReport({
                                    sessionId: input.sessionId,
                                    observation: input.observation,
                                });
                                params.onPublishError?.(retryError);
                                return;
                            }
                        }

                        emitLegacyReport({
                            sessionId: input.sessionId,
                            observation: input.observation,
                        });
                        params.onPublishError?.(error);
                        return;
                    }

                    params.onPublishError?.(error);
                    return;
                }
            }

            emitLegacyReport({
                sessionId: input.sessionId,
                observation: input.observation,
            });
        },
    };
}
