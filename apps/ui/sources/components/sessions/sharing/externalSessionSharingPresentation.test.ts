import { describe, expect, it } from 'vitest';
import { ExternalSessionOperationSharedPresentationV1Schema } from '@happier-dev/protocol/sessions/external/operationV1';

import { resolveExternalSessionSharingPresentation } from './externalSessionSharingPresentation';

describe('resolveExternalSessionSharingPresentation', () => {
    it('disables machine-only sharing with an import action owned by the materialization workflow', () => {
        expect(resolveExternalSessionSharingPresentation({
            machineName: 'Studio Mac',
            sharing: { kind: 'requires_persisted_import' },
        })).toEqual({
            shareable: false,
            state: 'requires_persisted_import',
            machineName: 'Studio Mac',
            action: 'import_awaiting_action_owner',
            materializedThroughSourceAt: null,
        });
    });

    it('keeps initial partial materialization unshareable', () => {
        expect(resolveExternalSessionSharingPresentation({
            machineName: 'Studio Mac',
            sharing: { kind: 'import_incomplete' },
        })).toMatchObject({
            shareable: false,
            state: 'import_incomplete',
            action: 'resume_awaiting_action_owner',
        });
    });

    it('keeps partial publication in flight while the same import is still running', () => {
        expect(resolveExternalSessionSharingPresentation({
            machineName: 'Studio Mac',
            sharing: { kind: 'import_incomplete' },
            operation: ExternalSessionOperationSharedPresentationV1Schema.parse({
                v: 1, operationId: 'import-1', revision: 2, kind: 'materialize',
                status: 'running', phase: 'importing',
            }),
        })).toMatchObject({
            shareable: false,
            state: 'import_incomplete',
            action: 'materialize_in_flight',
        });
    });

    it.each([
        { kind: 'requires_persisted_import' },
        { kind: 'published_snapshot', materializedThroughSourceAt: 1_700_000_000_000 },
    ] as const)('replaces the sharing start action while a published materialization runs ($kind)', (sharing) => {
        const input = {
            machineName: 'Studio Mac',
            sharing,
            operation: ExternalSessionOperationSharedPresentationV1Schema.parse({
                v: 1, operationId: 'import-1', revision: 1, kind: 'materialize',
                status: 'running', phase: 'importing',
            }),
        };
        expect(resolveExternalSessionSharingPresentation(input).action).toBe('materialize_in_flight');
    });

    it('shows published linked snapshots as shareable but stale', () => {
        expect(resolveExternalSessionSharingPresentation({
            machineName: 'Studio Mac',
            sharing: {
                kind: 'published_snapshot',
                materializedThroughSourceAt: 1_700_000_000_000,
            },
        })).toEqual({
            shareable: true,
            state: 'shared_snapshot_stale',
            machineName: 'Studio Mac',
            action: 'update_awaiting_action_owner',
            materializedThroughSourceAt: 1_700_000_000_000,
        });
    });

    it('treats persisted takeover and ordinary hosted sessions as normal sharing', () => {
        expect(resolveExternalSessionSharingPresentation({
            machineName: null,
            sharing: { kind: 'hosted' },
        })).toMatchObject({
            shareable: true,
            state: 'hosted',
            action: 'none',
        });
    });

    it('renders legacy linked shares as typed unavailable rather than an empty transcript', () => {
        expect(resolveExternalSessionSharingPresentation({
            machineName: 'Old Mac',
            sharing: { kind: 'unavailable', reason: 'legacy_external_unknown' },
        })).toMatchObject({
            shareable: false,
            state: 'transcript_unavailable',
            action: 'none',
        });
    });
});
