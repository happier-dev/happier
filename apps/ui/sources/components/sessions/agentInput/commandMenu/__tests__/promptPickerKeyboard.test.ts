import { describe, expect, it } from 'vitest';
import type { NormalizedKeyboardEvent } from '@/keyboard/types';
import { resolvePromptPickerKeyAction } from '../promptPickerKeyboard';

const enter: NormalizedKeyboardEvent = { key: 'Enter', code: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false };
const letterD: NormalizedKeyboardEvent = { ...enter, key: 'd', code: 'KeyD' };
describe('prompt picker key actions', () => {
    it.each(['macos', 'windows', 'linux', 'ios', 'android'] as const)('uses the canonical Mod on %s: Enter inserts, Mod+Enter sends, Mod+D favourites', (platform) => {
        expect(resolvePromptPickerKeyAction(enter, platform)).toBe('insert');
        const modifier = platform === 'macos' || platform === 'ios' ? 'metaKey' : 'ctrlKey';
        expect(resolvePromptPickerKeyAction({ ...enter, [modifier]: true }, platform)).toBe('send');
        expect(resolvePromptPickerKeyAction({ ...enter, [modifier]: true, isComposing: true }, platform)).toBeNull();
        expect(resolvePromptPickerKeyAction({ ...enter, altKey: true }, platform)).toBeNull();
        expect(resolvePromptPickerKeyAction({ ...letterD, [modifier]: true }, platform)).toBe('favorite');
        expect(resolvePromptPickerKeyAction(letterD, platform)).toBeNull();
    });

    it('recognises Mod+D from a field bridge that reports only the key, not the physical code', () => {
        expect(resolvePromptPickerKeyAction({ ...letterD, code: '', metaKey: true }, 'macos')).toBe('favorite');
        expect(resolvePromptPickerKeyAction({ ...letterD, key: 'D', code: '', ctrlKey: true }, 'windows')).toBe('favorite');
    });
});
