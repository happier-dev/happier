import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { describe, expect, it } from 'vitest';

import type { NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { isUserFacingSession } from './isUserFacingSession';

/** The same shape the Session projection installs on a row, built from the real owner. */
function accessProjection(role: 'owner' | 'recipient'): NormalizedSessionAccessProjection {
    const level = role === 'owner' ? 'owner' as const : 'view' as const;
    return {
        role,
        level,
        capabilities: projectLegacySessionAccessCapabilitiesV1({ level, canApprovePermissions: false }),
    };
}

describe('isUserFacingSession', () => {
    it('excludes hidden system sessions', () => {
        expect(isUserFacingSession({
            metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
        })).toBe(false);
    });

    it('keeps Voice transcript history out of ordinary coding-session lists', () => {
        expect(isUserFacingSession({
            metadata: {
                systemSessionV1: {
                    v: 1,
                    key: 'voice_transcript_history',
                    hidden: true,
                },
            },
        })).toBe(false);
    });

    it('excludes projected hidden system session rows', () => {
        expect(isUserFacingSession({
            metadata: { hiddenSystemSession: true },
        })).toBe(false);
    });

    it('keeps visible system sessions when they are not hidden', () => {
        expect(isUserFacingSession({
            metadata: { systemSessionV1: { v: 1, key: 'diagnostics', hidden: false } },
        })).toBe(true);
    });

    it('keeps ordinary user sessions', () => {
        expect(isUserFacingSession({
            metadata: { summary: { text: 'User-visible work', updatedAt: 1 } },
        })).toBe(true);
    });

    it('fails unavailable when a layout-v1 row has no owner compatibility view', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            },
            ownerMetadataView: null,
        })).toBe(false);
    });

    it('keeps layout-v1 participant rows visible from their strict shared projection', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            },
            ownerMetadataView: null,
        })).toBe(true);
    });

    it('keeps an authorized recipient visible while its encrypted metadata is still locked', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: null,
            metadataUnavailable: true,
            access: {
                role: 'recipient',
                level: 'view',
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            },
        })).toBe(true);
    });

    it('still hides a locked row that carries a retained hidden system fact', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: { hiddenSystemSession: true },
            metadataUnavailable: true,
            access: {
                role: 'recipient',
                level: 'view',
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            },
        })).toBe(false);
    });

    it('keeps an owner row with unreadable metadata hidden because its hidden-system fact is owner-private', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: null,
            metadataUnavailable: true,
            access: {
                role: 'owner',
                level: 'owner',
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
            },
        })).toBe(false);
    });

    it('keeps a locked owner visible when its independently opened owner metadata proves it is not hidden', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: {
                systemSessionV1: { v: 1, key: 'ordinary_owner_session', hidden: false },
            },
            metadataUnavailable: true,
            access: accessProjection('owner'),
        })).toBe(true);
    });

    it('still hides a locked owner when its independently opened owner metadata marks a system Session hidden', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: {
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
            metadataUnavailable: true,
            access: accessProjection('owner'),
        })).toBe(false);
    });

    it('does not infer authorization from an absent access projection on an unreadable row', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: null,
            metadataUnavailable: true,
        })).toBe(false);
    });

    it('reads layout-v1 system visibility from the owner compatibility view', () => {
        expect(isUserFacingSession({
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                systemSessionV1: { v: 1, key: 'injected-visible', hidden: false },
            },
            ownerMetadataView: {
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        })).toBe(false);
    });
});
