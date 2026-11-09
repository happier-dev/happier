import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const { shareApprovalPromptRoom } = await import('./ApprovalPromptChrome');

describe('shareApprovalPromptRoom', () => {
    it('shows a short request whole and lets the long one scroll its facts', () => {
        const bounds = shareApprovalPromptRoom(300, new Map([
            ['permission', { natural: 157, minimum: 129 }],
            ['terminal', { natural: 560, minimum: 101 }],
        ]));
        expect(bounds.get('permission')).toBe(157);
        expect(bounds.get('terminal')).toBe(143);
    });

    it('gives every request its full height when they all fit', () => {
        const bounds = shareApprovalPromptRoom(300, new Map([['a', { natural: 100, minimum: 80 }], ['b', { natural: 120, minimum: 90 }]]));
        expect([bounds.get('a'), bounds.get('b')]).toEqual([100, 120]);
    });

    it('keeps every request readable when their decisions cannot all fit: the tray scrolls between them', () => {
        const bounds = shareApprovalPromptRoom(196, new Map([
            ['failed', { natural: 76, minimum: 76 }],
            ['navigate', { natural: 130, minimum: 105 }],
            ['choose-window', { natural: 178, minimum: 95 }],
            ['long', { natural: 560, minimum: 95 }],
        ]));
        expect([bounds.get('failed'), bounds.get('navigate'), bounds.get('choose-window'), bounds.get('long')]).toEqual([76, 130, 178, 196]);
    });

    it('never gives a request less than its head and decision, nor more than the tray can show', () => {
        const bounds = shareApprovalPromptRoom(150, new Map([['a', { natural: 400, minimum: 110 }], ['b', { natural: 500, minimum: 110 }]]));
        expect([bounds.get('a'), bounds.get('b')]).toEqual([150, 150]);
    });
});
