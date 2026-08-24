import { describe, expect, it, vi } from 'vitest';

import { resolveNewSessionDraftRouteIdentity } from './newSessionDraftRouteIdentity';
import {
    resolveNewSessionOrdinaryEntryRoute,
    shouldForceFreshNewSessionEntry,
    shouldForceFreshNewSessionEntryFromPressEvent,
} from './newSessionOrdinaryEntryRoute';

describe('resolveNewSessionDraftRouteIdentity', () => {
    it('keeps a valid route draft id as the authoring identity', () => {
        const createDraftId = vi.fn(() => '00000000-0000-4000-8000-000000000002');

        expect(resolveNewSessionDraftRouteIdentity({
            routeDraftId: ' 00000000-0000-4000-8000-000000000001 ',
            createDraftId,
        })).toEqual({
            draftId: '00000000-0000-4000-8000-000000000001',
            shouldWriteRouteParam: false,
        });
        expect(createDraftId).not.toHaveBeenCalled();
    });

    it.each([undefined, '', 'not-a-uuid', ['00000000-0000-4000-8000-000000000001']])(
        'creates a UUID route identity when the route value is absent or invalid (%j)',
        (routeDraftId) => {
            expect(resolveNewSessionDraftRouteIdentity({
                routeDraftId,
                createDraftId: () => '00000000-0000-4000-8000-000000000002',
            })).toEqual({
                draftId: '00000000-0000-4000-8000-000000000002',
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
            ordinaryEntryDraftId: '00000000-0000-4000-8000-000000000001',
            ordinaryEntryDraftIsMeaningful: true,
            createDraftId: () => '00000000-0000-4000-8000-000000000002',
        })).toEqual({
            draftId: '00000000-0000-4000-8000-000000000001',
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
            ordinaryEntryDraftId: '00000000-0000-4000-8000-000000000001',
            createDraftId: () => '00000000-0000-4000-8000-000000000002',
        })).toEqual({
            draftId: '00000000-0000-4000-8000-000000000002',
            draftOrigin: 'ordinary',
            resumedPrevious: false,
        });
    });

    it('does not resume an invalid remembered identity even if stale metadata calls it meaningful', () => {
        expect(resolveNewSessionOrdinaryEntryRoute({
            entryMode: 'resumePrevious',
            forceFresh: false,
            ordinaryEntryDraftId: 'not-a-uuid',
            ordinaryEntryDraftIsMeaningful: true,
            createDraftId: () => '00000000-0000-4000-8000-000000000002',
        })).toEqual({
            draftId: '00000000-0000-4000-8000-000000000002',
            draftOrigin: 'ordinary',
            resumedPrevious: false,
        });
    });
});

describe('shouldForceFreshNewSessionEntry', () => {
    it('uses Command on macOS and Control everywhere else', () => {
        expect(shouldForceFreshNewSessionEntry({ platform: 'macos', metaKey: true, ctrlKey: false })).toBe(true);
        expect(shouldForceFreshNewSessionEntry({ platform: 'macos', metaKey: false, ctrlKey: true })).toBe(false);
        expect(shouldForceFreshNewSessionEntry({ platform: 'windows', metaKey: false, ctrlKey: true })).toBe(true);
        expect(shouldForceFreshNewSessionEntry({ platform: 'linux', metaKey: true, ctrlKey: false })).toBe(false);
    });

    it('reads modifiers from both press-event layers through the canonical platform resolver', () => {
        expect(shouldForceFreshNewSessionEntryFromPressEvent({ metaKey: true }, 'macos')).toBe(true);
        expect(shouldForceFreshNewSessionEntryFromPressEvent({ nativeEvent: { ctrlKey: true } }, 'windows')).toBe(true);
        expect(shouldForceFreshNewSessionEntryFromPressEvent({ nativeEvent: { metaKey: true } }, 'windows')).toBe(false);
        expect(shouldForceFreshNewSessionEntryFromPressEvent(undefined, 'macos')).toBe(false);
    });
});
