import {
    ExternalSessionOperationProgressV1Schema,
    ExternalSessionOperationSharedPresentationV1Schema,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { readExternalSessionOperationPresentationFromMetadata } from './externalSessionOperationMetadata';
import { appendExternalSessionOperationTranscriptItem } from './externalSessionOperationTranscriptItem';

function createCompleteProgress(
    overrides: Partial<ExternalSessionOperationProgressV1> = {},
): ExternalSessionOperationProgressV1 {
    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        request: {
            plan: 'materialize',
            targetStorageMode: 'external-linked',
            targetRuntimeMode: null,
        },
        status: 'running',
        phase: 'validating',
        timeline: [
            'validating',
            'staging',
            'importing',
            'publishing',
        ],
        updatedAtMs: 1_700_000_000_000,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: 'machine_only',
        checkpoint: {
            sourcePagesRead: 0,
            stagedItemCount: 0,
            importedItemCount: 0,
            requiredItemFailures: {
                total: 0,
                record: 0,
                media: 0,
                conversion: 0,
                diagnosticsTruncated: false,
            },
        },
        fence: { kind: 'none' },
        ...overrides,
    });
}

describe('external session operation transcript hydration', () => {
    it('projects only the strict shared presentation into the generic transcript item', () => {
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1,
            operationId: 'operation-1',
            revision: 4,
            kind: 'materialize',
            status: 'running',
            phase: 'validating',
        });
        const metadata = {
            externalSessionOperationPresentationV1: presentation,
        };

        expect(readExternalSessionOperationPresentationFromMetadata(metadata))
            .toEqual(presentation);
        expect(appendExternalSessionOperationTranscriptItem([], {
            presentation,
            progress: null,
        })).toEqual([{
            kind: 'external-session-operation',
            id: 'external-session-operation:operation-1',
            presentation,
            progress: null,
            createdAt: 0,
        }]);
    });

    it('embeds complete progress only when its exact identity matches the shared presentation', () => {
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1,
            operationId: 'operation-1',
            revision: 4,
            kind: 'materialize',
            status: 'running',
            phase: 'validating',
        });
        const progress = createCompleteProgress();

        expect(appendExternalSessionOperationTranscriptItem([], {
            presentation,
            progress,
        })).toEqual([expect.objectContaining({
            presentation,
            progress,
        })]);
        expect(appendExternalSessionOperationTranscriptItem([], {
            presentation,
            progress: createCompleteProgress({ revision: 5 }),
        })).toEqual([expect.objectContaining({
            presentation,
            progress: null,
        })]);
        expect(appendExternalSessionOperationTranscriptItem([], {
            presentation,
            progress: createCompleteProgress({ operationId: 'operation-2' }),
        })).toEqual([expect.objectContaining({
            presentation,
            progress: null,
        })]);
    });

    it('fails closed for malformed, private, or legacy complete shared metadata', () => {
        expect(readExternalSessionOperationPresentationFromMetadata({
            externalSessionOperationPresentationV1: {
                v: 1,
                operationId: 'operation-1',
                revision: 4,
                kind: 'materialize',
                status: 'running',
                phase: 'validating',
                checkpoint: { importedItemCount: 10 },
            },
        })).toBeNull();
        expect(readExternalSessionOperationPresentationFromMetadata({
            externalSessionOperationV1: {
                v: 1,
                progress: createCompleteProgress(),
            },
        })).toBeNull();
    });

    it('dismisses only the exact presented revision', () => {
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1,
            operationId: 'operation-1',
            revision: 4,
            kind: 'materialize',
            status: 'completed',
            phase: 'publishing',
        });

        expect(appendExternalSessionOperationTranscriptItem([], {
            presentation,
            progress: null,
        }, {
            sessionId: 'session-1',
            dismissed: {
                sessionId: 'session-1',
                operationId: 'operation-1',
                revision: 4,
            },
        })).toEqual([]);
        expect(appendExternalSessionOperationTranscriptItem([], {
            presentation: { ...presentation, revision: 5 },
            progress: null,
        }, {
            sessionId: 'session-1',
            dismissed: {
                sessionId: 'session-1',
                operationId: 'operation-1',
                revision: 4,
            },
        })).toHaveLength(1);
    });
});
