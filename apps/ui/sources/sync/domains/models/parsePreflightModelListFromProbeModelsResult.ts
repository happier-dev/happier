import type { AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';

export function parsePreflightModelListFromProbeModelsResult(raw: unknown): PreflightModelList | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const modelsRaw = (rec as any).availableModels;
    const supportsFreeformRaw = (rec as any).supportsFreeform;
    const sourceRaw = typeof rec.source === 'string' ? rec.source : null;
    if (!Array.isArray(modelsRaw)) return null;

    const parsed: PreflightModelList = {
        availableModels: modelsRaw
            .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m: any) => ({
                id: String(m.id),
                name: String(m.name),
                ...(typeof m.description === 'string' ? { description: m.description } : {}),
                ...(typeof m.extendedContextModelId === 'string' && m.extendedContextModelId.trim().length > 0
                    ? { extendedContextModelId: m.extendedContextModelId.trim() }
                    : {}),
                ...(Array.isArray(m.modelOptions) && m.modelOptions.length > 0
                    ? { modelOptions: m.modelOptions as readonly AcpConfigOption[] }
                    : {}),
            })),
        supportsFreeform: Boolean(supportsFreeformRaw),
        ...(sourceRaw === 'unavailable' ? { unavailable: true } : {}),
    };

    if (
        parsed.availableModels.length === 0
        && parsed.supportsFreeform !== true
        && parsed.unavailable !== true
    ) {
        return null;
    }
    return parsed;
}
