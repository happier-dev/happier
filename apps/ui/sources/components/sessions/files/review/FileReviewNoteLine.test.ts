// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('file review note line', () => {
    it('names the turn by its place in the Session, and leaves it out when the turn is unknown', async () => {
        const { fileReviewNoteText } = await import('./FileReviewNoteLine');
        const turns = [{ turnId: 'turn-b', startedAt: 20 }, { turnId: 'turn-a', startedAt: 10 }];
        expect(fileReviewNoteText({ action: 'restore', paths: ['src/app.ts'], turnId: 'turn-b' }, turns))
            .toBe('fileReviewNote.restoreBeforeTurn(paths=src/app.ts,turn=hunkReview.turn(turn=2))');
        expect(fileReviewNoteText({ action: 'restore', paths: ['src/app.ts'], turnId: 'turn-z' }, turns))
            .toContain('fileReviewNote.restore');
        expect(fileReviewNoteText({ action: 'restore', paths: ['src/app.ts'], turnId: 'turn-z' }, turns))
            .not.toContain('restoreBeforeTurn');
        expect(fileReviewNoteText({ action: 'discard', paths: ['src/app.ts'], changeCount: 2, turnId: 'turn-a' }, turns))
            .toBe('fileReviewNote.discard(paths=src/app.ts,count=2) (hunkReview.turn(turn=1))');
    });
});
