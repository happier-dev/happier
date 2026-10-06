import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { applySessionListRenderablePatch, areSessionListRenderablesEqual, buildSessionListRenderableFromSession } from './sessionListRenderable';
import { buildSessionFromListRenderable } from './sessionListRenderableSessionProjection';

describe('locked shared title projection', () => {
    const title = 'Previously authorized shared title';
    const locked = createSessionFixture({
        serverId: 'home-a', metadataLayoutVersion: 1, encryptionMode: 'e2ee',
        encryptedContentAvailability: 'encrypted_access_needs_repair',
        metadata: null, ownerMetadataView: null,
        access: createSessionAccessFixture('view'), accessLevel: 'view',
        lockedDisplayTitle: title,
    });

    it('carries only the trusted title through a cold locked projection and reconstruction', () => {
        const cold = buildSessionListRenderableFromSession(locked);
        expect(getSessionName(cold)).toBe(title);
        expect(cold.metadata).toBeNull();
        const reconstructed = buildSessionFromListRenderable(cold, { serverId: 'home-a' });
        expect(getSessionName(reconstructed)).toBe(title);
        expect(reconstructed.metadata).toBeNull();
        expect(reconstructed.ownerMetadataView).toBeNull();
    });

    it('does not copy previous metadata while carrying a trusted warm locked title', () => {
        const cold = buildSessionListRenderableFromSession(locked);
        const warm = buildSessionListRenderableFromSession(locked, {
            ...cold,
            metadata: { summaryText: 'Old title', path: '/private/owner', host: 'owner.local' },
        });
        expect(getSessionName(warm)).toBe(title);
        expect(warm.metadata).toBeNull();
    });

    it('does not revive a retired title from the previous row after a Home change', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        const cleared = buildSessionListRenderableFromSession({
            ...locked, serverId: 'home-b', lockedDisplayTitle: null,
        }, previous);
        expect(getSessionName(cleared)).not.toBe(title);
        expect(cleared.metadata).toBeNull();
        expect(getSessionName(buildSessionFromListRenderable(cleared, {
            baseSession: locked, serverId: 'home-b',
        }))).not.toBe(title);
    });

    it('clears the retained title when shared content becomes readable without a title', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        const readable = buildSessionListRenderableFromSession({
            ...locked, encryptedContentAvailability: 'ready',
            metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
        }, previous);
        expect(getSessionName(readable)).not.toBe(title);
        expect(getSessionName(buildSessionFromListRenderable(readable, { baseSession: locked }))).not.toBe(title);
    });

    it('clears the retained title when access no longer identifies a recipient', () => {
        const previous = buildSessionListRenderableFromSession(locked);
        for (const access of [createSessionAccessFixture('owner'), null]) {
            const cleared = buildSessionListRenderableFromSession({ ...locked, access, accessLevel: undefined }, previous);
            expect(getSessionName(cleared)).not.toBe(title);
            expect(getSessionName(buildSessionFromListRenderable(cleared, { baseSession: locked }))).not.toBe(title);
        }
    });

    it('observes title-only changes and retirement in the canonical row comparison', () => {
        const row = buildSessionListRenderableFromSession(locked);
        const previous = { ...row, lockedDisplayTitle: title };
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: 'Changed title' })).toBe(false);
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: null })).toBe(false);
        expect(areSessionListRenderablesEqual(previous, { ...row, lockedDisplayTitle: title })).toBe(true);
    });

    it('clears the memory title when a list patch changes content or recipient access', () => {
        const row = { ...buildSessionListRenderableFromSession(locked), lockedDisplayTitle: title };
        const readable = applySessionListRenderablePatch(row, { metadata: { path: '', summaryText: null } });
        expect(readable).toHaveProperty('lockedDisplayTitle', null);
        const retired = applySessionListRenderablePatch(row, { access: null, accessLevel: undefined });
        expect(getSessionName(retired)).not.toBe(title);
    });
});

describe('buildSessionFromListRenderable', () => {
    it('preserves the safe responsible Account summary through list renderable reconstruction', () => {
        const responsibleAccount = {
            kind: 'account' as const,
            accountId: 'account-alice',
            firstName: 'Alice',
            lastName: null,
            username: 'alice',
            avatarUrl: null,
        };
        const source = createSessionFixture({
            id: 'assigned-session',
            responsibleAccountId: responsibleAccount.accountId,
            responsibleAccount,
        });

        const renderable = buildSessionListRenderableFromSession(source);
        expect(renderable.responsibleAccountId).toBe(responsibleAccount.accountId);
        expect(renderable.responsibleAccount).toEqual(responsibleAccount);

        const reconstructed = buildSessionFromListRenderable(renderable);
        expect(reconstructed.responsibleAccountId).toBe(responsibleAccount.accountId);
        expect(reconstructed.responsibleAccount).toEqual(responsibleAccount);
    });

    it('keeps omitted and explicit-null responsibility summaries distinct', () => {
        const omitted = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'unsupported-session',
        }));
        const unassigned = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'unassigned-session',
            responsibleAccountId: null,
            responsibleAccount: null,
        }));

        expect('responsibleAccount' in omitted).toBe(false);
        expect(unassigned.responsibleAccount).toBeNull();
        expect('responsibleAccount' in buildSessionFromListRenderable(omitted)).toBe(false);
        expect(buildSessionFromListRenderable(unassigned).responsibleAccount).toBeNull();
    });

    it('reconstructs a layout-v1 owner metadata view without exposing it to recipients', () => {
        const ownerMetadata = {
            path: '/home/alice/project',
            homeDir: '/home/alice',
            host: 'workstation',
            machineId: 'machine-a',
        };
        const renderable = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'layout-v1-owner',
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: ownerMetadata,
            access: {
                role: 'owner',
                level: 'owner',
                capabilities: projectLegacySessionAccessCapabilitiesV1({
                    level: 'owner',
                    canApprovePermissions: true,
                }),
            },
        }));

        const ownerSession = buildSessionFromListRenderable(renderable);
        expect(ownerSession.metadataLayoutVersion).toBe(1);
        expect(readSessionOwnerMetadataView(ownerSession)).toMatchObject(ownerMetadata);

        const recipientSession = buildSessionFromListRenderable({
            ...renderable,
            access: {
                role: 'recipient',
                level: 'view',
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            },
            accessLevel: 'view',
        });
        expect(recipientSession.metadataLayoutVersion).toBe(1);
        expect(recipientSession.ownerMetadataView).toBeNull();
        expect(readSessionOwnerMetadataView(recipientSession)).toBeNull();
    });
});
