import { describe, expect, it, vi } from 'vitest';

import { resolveNewSessionDraftRouteIdentity } from './newSessionDraftRouteIdentity';
import {
    resolveNewSessionOrdinaryEntryRoute,
    shouldForceFreshNewSessionEntry,
    shouldForceFreshNewSessionEntryFromPressEvent,
} from './newSessionOrdinaryEntryRoute';

describe('resolveNewSessionDraftRouteIdentity', () => {
    it('preserves the exact canonical draft identity from the route', () => {
        expect(resolveNewSessionDraftRouteIdentity({
            routeDraftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            createDraftId: vi.fn(),
        })).toEqual({
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            shouldWriteRouteParam: false,
        });
    });

    it.each([undefined, ['4a506d8a-85bd-4c42-a662-6f502f3acc45'], 'not-a-uuid'])(
        'creates a fresh identity for absent or invalid route input %j',
        (routeDraftId) => {
            expect(resolveNewSessionDraftRouteIdentity({
                routeDraftId,
                createDraftId: () => '23c4d625-58a3-499d-bd2c-a7dd13e352e8',
            })).toEqual({
                draftId: '23c4d625-58a3-499d-bd2c-a7dd13e352e8',
                shouldWriteRouteParam: true,
            });
        },
    );
});

describe('resolveNewSessionOrdinaryEntryRoute', () => {
    it('resumes only a still-meaningful origin-owned draft when the preference allows it', () => {
        expect(resolveNewSessionOrdinaryEntryRoute({
            entryMode: 'resumePrevious',
            forceFresh: false,
            ordinaryEntryDraftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            ordinaryEntryDraftIsMeaningful: true,
            createDraftId: () => '23c4d625-58a3-499d-bd2c-a7dd13e352e8',
        })).toEqual({
            draftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            draftOrigin: 'ordinary',
            resumedPrevious: true,
        });
    });

    it.each([
        { entryMode: 'alwaysFresh' as const, forceFresh: false, ordinaryEntryDraftIsMeaningful: true },
        { entryMode: 'resumePrevious' as const, forceFresh: true, ordinaryEntryDraftIsMeaningful: true },
        { entryMode: 'resumePrevious' as const, forceFresh: false, ordinaryEntryDraftIsMeaningful: false },
    ])('allocates a fresh ordinary identity for $entryMode forceFresh=$forceFresh meaningful=$ordinaryEntryDraftIsMeaningful', (input) => {
        expect(resolveNewSessionOrdinaryEntryRoute({
            ...input,
            ordinaryEntryDraftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            createDraftId: () => '23c4d625-58a3-499d-bd2c-a7dd13e352e8',
        })).toEqual({
            draftId: '23c4d625-58a3-499d-bd2c-a7dd13e352e8',
            draftOrigin: 'ordinary',
            resumedPrevious: false,
        });
    });

    it('does not resume an invalid remembered identity even when stale metadata calls it meaningful', () => {
        expect(resolveNewSessionOrdinaryEntryRoute({
            entryMode: 'resumePrevious',
            forceFresh: false,
            ordinaryEntryDraftId: 'not-a-uuid',
            ordinaryEntryDraftIsMeaningful: true,
            createDraftId: () => '23c4d625-58a3-499d-bd2c-a7dd13e352e8',
        })).toMatchObject({
            draftId: '23c4d625-58a3-499d-bd2c-a7dd13e352e8',
            resumedPrevious: false,
        });
    });
});

describe('ordinary New Session fresh-entry modifier', () => {
    it('uses Command on macOS and Control everywhere else', () => {
        expect(shouldForceFreshNewSessionEntry({ platform: 'macos', metaKey: true, ctrlKey: false })).toBe(true);
        expect(shouldForceFreshNewSessionEntry({ platform: 'macos', metaKey: false, ctrlKey: true })).toBe(false);
        expect(shouldForceFreshNewSessionEntry({ platform: 'windows', metaKey: false, ctrlKey: true })).toBe(true);
        expect(shouldForceFreshNewSessionEntry({ platform: 'linux', metaKey: true, ctrlKey: false })).toBe(false);
    });

    it('reads modifiers from both press-event layers', () => {
        expect(shouldForceFreshNewSessionEntryFromPressEvent({ metaKey: true }, 'macos')).toBe(true);
        expect(shouldForceFreshNewSessionEntryFromPressEvent({ nativeEvent: { ctrlKey: true } }, 'windows')).toBe(true);
        expect(shouldForceFreshNewSessionEntryFromPressEvent({ nativeEvent: { metaKey: true } }, 'windows')).toBe(false);
        expect(shouldForceFreshNewSessionEntryFromPressEvent(undefined, 'macos')).toBe(false);
    });
});
