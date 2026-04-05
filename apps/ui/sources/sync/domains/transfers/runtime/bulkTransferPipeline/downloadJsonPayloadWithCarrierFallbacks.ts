type JsonPayloadResult<TPayload> =
    | Readonly<{ ok: true; payload: TPayload }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

export async function downloadJsonPayloadWithCarrierFallbacks<TPayload>(params: Readonly<{
    downloadViaDirectExport: () => Promise<JsonPayloadResult<TPayload>>;
    downloadViaServerRelay: () => Promise<JsonPayloadResult<TPayload>>;
    downloadViaLegacyBulk: () => Promise<JsonPayloadResult<TPayload>>;
}>): Promise<JsonPayloadResult<TPayload>> {
    const normalizeThrownError = (error: unknown): JsonPayloadResult<TPayload> => ({
        ok: false,
        error: error instanceof Error ? error.message : 'Downloaded transfer payload returned an unsupported response',
    });

    let directExportResult: JsonPayloadResult<TPayload>;
    try {
        directExportResult = await params.downloadViaDirectExport();
    } catch (error) {
        directExportResult = normalizeThrownError(error);
    }
    if (directExportResult.ok) {
        return directExportResult;
    }

    let relayResult: JsonPayloadResult<TPayload>;
    try {
        relayResult = await params.downloadViaServerRelay();
    } catch (error) {
        relayResult = normalizeThrownError(error);
    }
    if (relayResult.ok) {
        return relayResult;
    }

    try {
        return await params.downloadViaLegacyBulk();
    } catch (error) {
        return normalizeThrownError(error);
    }
}
