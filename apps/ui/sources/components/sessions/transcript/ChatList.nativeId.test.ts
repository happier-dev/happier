import { describe, expect, it } from 'vitest';

import { buildChatListNativeId } from './chatListNativeId';

describe('ChatList nativeID', () => {
    it('sanitizes React ids for DOM/nativeID usage', () => {
        expect(buildChatListNativeId('s1', ':r1:')).toBe('ChatList.s1.r1');
        expect(buildChatListNativeId('s1', '::')).toBe('ChatList.s1.instance');
        expect(buildChatListNativeId('', ':r2:')).toBe('ChatList.unknown.r2');
        expect(buildChatListNativeId('s/1', ':r3:')).toBe('ChatList.s1.r3');
    });
});
