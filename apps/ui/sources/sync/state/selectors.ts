import type { Session } from '@/sync/domains/state/storageTypes';

type SessionMetadataCarrier = Readonly<{
    metadata?: unknown;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function readSessionDisplayTitleField(session: SessionMetadataCarrier | null | undefined): Readonly<{
    value: string | null;
    updatedAt: number | null;
}> {
    const metadata = asRecord(session?.metadata);
    const summary = asRecord(metadata?.summary);
    const rawValue = typeof summary?.text === 'string' ? summary.text.trim() : '';
    const rawRenderableValue = rawValue.length > 0
        ? rawValue
        : typeof metadata?.summaryText === 'string'
            ? metadata.summaryText.trim()
            : '';
    return {
        value: rawRenderableValue || null,
        updatedAt: typeof summary?.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
            ? summary.updatedAt
            : null,
    };
}

export function readSessionPermissionModeField(session: Session | null | undefined): Readonly<{
    value: Session['permissionMode'] | null;
    updatedAt: number | null;
}> {
    return {
        value: session?.permissionMode ?? null,
        updatedAt: typeof session?.permissionModeUpdatedAt === 'number' ? session.permissionModeUpdatedAt : null,
    };
}

export function readSessionModelModeField(session: Session | null | undefined): Readonly<{
    value: Session['modelMode'] | null;
    updatedAt: number | null;
}> {
    return {
        value: session?.modelMode ?? null,
        updatedAt: typeof session?.modelModeUpdatedAt === 'number' ? session.modelModeUpdatedAt : null,
    };
}
