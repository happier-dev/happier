import { describe, expect, it } from 'vitest';

import {
    browserShortcutConflicts,
    formatKeybindingCaptureEvent,
    formatKeybindingLabel,
    matchKeybindingRule,
    parseKeybindingRule,
    resolveModModifier,
} from './bindings';
import type { KeyboardContext, NormalizedKeyboardEvent } from './types';

const baseContext: KeyboardContext = {
    isEditableTarget: false,
    isComposing: false,
};

function keyEvent(event: Partial<NormalizedKeyboardEvent>): NormalizedKeyboardEvent {
    return {
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        ...event,
    };
}

describe('keyboard bindings', () => {
    it('resolves mod to the platform primary modifier', () => {
        expect(resolveModModifier('macos')).toBe('meta');
        expect(resolveModModifier('ios')).toBe('meta');
        expect(resolveModModifier('windows')).toBe('ctrl');
        expect(resolveModModifier('linux')).toBe('ctrl');
        expect(resolveModModifier('android')).toBe('ctrl');
    });

    it('matches layout-independent shortcuts by code with platform-correct mod', () => {
        const rule = parseKeybindingRule('Mod+K');

        expect(matchKeybindingRule(rule, keyEvent({ code: 'KeyK', key: 'ø', metaKey: true }), {
            platform: 'macos',
            context: baseContext,
        })).toBe(true);
        expect(matchKeybindingRule(rule, keyEvent({ code: 'KeyK', key: 'k', ctrlKey: true }), {
            platform: 'windows',
            context: baseContext,
        })).toBe(true);
        expect(matchKeybindingRule(rule, keyEvent({ code: 'KeyK', key: 'k', ctrlKey: true }), {
            platform: 'macos',
            context: baseContext,
        })).toBe(false);
    });

    it('keeps single-key shortcuts out of editable targets', () => {
        const rule = parseKeybindingRule('?');

        expect(matchKeybindingRule(rule, keyEvent({ key: '?', code: 'Slash', shiftKey: true }), {
            platform: 'macos',
            context: { ...baseContext, isEditableTarget: true },
        })).toBe(false);
    });

    it('treats web-only binding platform rules as web surface rules', () => {
        const rule = parseKeybindingRule({ binding: 'Mod+K', platforms: ['web'] });
        const event = keyEvent({ code: 'KeyK', key: 'k', metaKey: true });

        expect(matchKeybindingRule(rule, event, {
            platform: 'macos',
            surface: 'web',
            context: baseContext,
        })).toBe(true);
        expect(matchKeybindingRule(rule, event, {
            platform: 'macos',
            surface: 'native',
            context: baseContext,
        })).toBe(false);
    });

    it('matches semantic Enter Escape and Tab bindings without physical key codes', () => {
        expect(matchKeybindingRule(parseKeybindingRule('Enter'), keyEvent({ key: 'Enter' }), {
            platform: 'macos',
            context: baseContext,
        })).toBe(true);
        expect(matchKeybindingRule(parseKeybindingRule('Escape'), keyEvent({ key: 'Escape' }), {
            platform: 'macos',
            context: baseContext,
        })).toBe(true);
        expect(matchKeybindingRule(parseKeybindingRule('Tab'), keyEvent({ key: 'Tab' }), {
            platform: 'macos',
            context: baseContext,
        })).toBe(true);
    });

    it('matches the question mark shortcut when the browser event omits a physical key code', () => {
        expect(matchKeybindingRule(parseKeybindingRule('?'), keyEvent({ key: '?', shiftKey: true }), {
            platform: 'macos',
            context: baseContext,
        })).toBe(true);
    });

    it('formats display labels from the parsed binding and current platform', () => {
        expect(formatKeybindingLabel(parseKeybindingRule('Mod+K'), 'macos')).toBe('Cmd+K');
        expect(formatKeybindingLabel(parseKeybindingRule('Mod+K'), 'windows')).toBe('Ctrl+K');
        expect(formatKeybindingLabel(parseKeybindingRule('?'), 'linux')).toBe('?');
    });

    it('formats captured keyboard events into editable shortcut bindings', () => {
        expect(formatKeybindingCaptureEvent({ key: 'h', code: 'KeyH', metaKey: true }, 'macos')).toBe('Mod+H');
        expect(formatKeybindingCaptureEvent({ key: 'h', code: 'KeyH', ctrlKey: true }, 'windows')).toBe('Mod+H');
        expect(formatKeybindingCaptureEvent({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }, 'macos')).toBe('Alt+ArrowDown');
        expect(formatKeybindingCaptureEvent({ key: 'Tab', code: 'Tab', shiftKey: true }, 'macos')).toBe('Shift+Tab');
        expect(formatKeybindingCaptureEvent({ key: '?', code: 'Slash', shiftKey: true }, 'macos')).toBe('?');
    });

    it('ignores modifier-only captured keyboard events', () => {
        expect(formatKeybindingCaptureEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true }, 'macos')).toBeNull();
        expect(formatKeybindingCaptureEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, 'windows')).toBeNull();
    });

    it('declares browser-reserved defaults as data', () => {
        expect(browserShortcutConflicts.some((conflict) => conflict.binding === 'Mod+N')).toBe(true);
        expect(browserShortcutConflicts.some((conflict) => conflict.binding === 'Mod+Shift+N')).toBe(true);
        expect(browserShortcutConflicts.every((conflict) => conflict.platforms.includes('web'))).toBe(true);
    });
});
