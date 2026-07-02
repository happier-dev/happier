import {
    isSupportedRuntimeDescriptorProviderId,
    readSessionMetadataRuntimeDescriptor,
} from '@happier-dev/agents';

import type {
    MessageContent,
    Metadata,
} from '../../types';
import type { ACPProvider } from '../sessionMessageTypes';

type CliMessageMeta = Readonly<Record<string, unknown> & {
    sentFrom: 'cli';
    source: 'cli';
}>;

export function buildCliMessageMeta(meta?: Record<string, unknown>): CliMessageMeta {
    return {
        sentFrom: 'cli',
        source: 'cli',
        ...(meta && typeof meta === 'object' ? meta : {}),
    };
}

export function readSidechainId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveUsageObservationExternalKey(params: Readonly<{
    body: unknown;
    fallbackLocalId?: string | null;
}>): string | null {
    const body = params.body && typeof params.body === 'object' && !Array.isArray(params.body)
        ? params.body as Record<string, unknown>
        : null;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    if (key.length > 0) {
        return key;
    }
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (id.length > 0) {
        return id;
    }
    const fallbackLocalId = typeof params.fallbackLocalId === 'string' ? params.fallbackLocalId.trim() : '';
    return fallbackLocalId.length > 0 ? fallbackLocalId : null;
}

export function resolveUsageObservationBackendMode(params: Readonly<{
    metadata: Metadata | null;
    provider: ACPProvider | 'codex';
}>): string | null {
    if (!isSupportedRuntimeDescriptorProviderId(params.provider)) return null;
    const descriptor = readSessionMetadataRuntimeDescriptor(params.metadata, params.provider);
    if (!descriptor || !('backendMode' in descriptor)) return null;
    return typeof descriptor.backendMode === 'string' && descriptor.backendMode.trim().length > 0
        ? descriptor.backendMode
        : null;
}

export function buildUserTextMessageContent(text: string, meta?: Record<string, unknown>): MessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: buildCliMessageMeta(meta),
    };
}
