import { randomUUID } from 'node:crypto';

import type { Metadata } from '../../../types';
import { normalizeCodexSessionMessageBody } from '../../sessionOutboundMessageNormalization';
import {
    buildCliMessageMeta,
    resolveUsageObservationBackendMode,
    resolveUsageObservationExternalKey,
} from '../shared';

export function buildCodexSessionOutboundMessage(params: Readonly<{
    body: unknown;
    metadata: Metadata | null;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    debug: (message: string, data?: unknown) => void;
}>): Readonly<{
    normalizedBody: any;
    content: {
        role: 'agent';
        content: {
            type: 'codex';
            data: any;
        };
        meta: Readonly<Record<string, unknown> & {
            sentFrom: 'cli';
            source: 'cli';
        }>;
    };
    localId: string;
    backendMode: string | null;
    externalKey: string | null;
}> {
    const normalizedBody = normalizeCodexSessionMessageBody({
        body: params.body,
        toolCallCanonicalNameByProviderAndId: params.toolCallCanonicalNameByProviderAndId,
        debug: params.debug,
    });
    const localId = randomUUID();

    return {
        normalizedBody,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: normalizedBody,
            },
            meta: buildCliMessageMeta(),
        },
        localId,
        backendMode: resolveUsageObservationBackendMode({
            metadata: params.metadata,
            provider: 'codex',
        }),
        externalKey: resolveUsageObservationExternalKey({
            body: normalizedBody,
            fallbackLocalId: localId,
        }),
    };
}
