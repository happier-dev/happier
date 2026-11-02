import { describe, it, expect } from 'vitest';
import {
    mapToClaudeMode,
    normalizeClaudeHappyCliSessionControlPermissionMode,
    resolveClaudeSdkPermissionModeFromEnhancedMode,
    shouldAllowClaudePermissionBypass,
} from './permissionMode';
import type { PermissionMode } from '@/api/types';

describe('Claude bypass capability across platforms', () => {
    it.each([
        { platform: 'win32', uid: 0, allowed: true },
        { platform: 'darwin', uid: 0, allowed: false },
        { platform: 'linux', uid: undefined, allowed: true },
    ])('preserves native eligibility on $platform with uid $uid', ({ platform, uid, allowed }) => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
        Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
        Object.defineProperty(process, 'getuid', { configurable: true, value: uid === undefined ? undefined : () => uid });
        try {
            expect(shouldAllowClaudePermissionBypass({})).toBe(allowed);
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
            if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor);
            else Reflect.deleteProperty(process, 'getuid');
        }
    });
});

describe('mapToClaudeMode', () => {
    describe('Codex modes are mapped to Claude equivalents', () => {
        it('maps yolo → bypassPermissions', () => {
            expect(mapToClaudeMode('yolo')).toBe('bypassPermissions');
        });

        it('maps safe-yolo → auto', () => {
            expect(mapToClaudeMode('safe-yolo')).toBe('auto');
        });

        it('maps read-only → dontAsk', () => {
            expect(mapToClaudeMode('read-only')).toBe('dontAsk');
        });
    });

    describe('Claude modes pass through unchanged', () => {
        it('passes through default', () => {
            expect(mapToClaudeMode('default')).toBe('default');
        });

        it('passes through acceptEdits', () => {
            expect(mapToClaudeMode('acceptEdits')).toBe('acceptEdits');
        });

        it('passes through bypassPermissions', () => {
            expect(mapToClaudeMode('bypassPermissions')).toBe('bypassPermissions');
        });

        it('passes through plan', () => {
            expect(mapToClaudeMode('plan')).toBe('plan');
        });
    });

    describe('all 7 PermissionMode values are handled', () => {
        const allModes: PermissionMode[] = [
            'default', 'acceptEdits', 'bypassPermissions', 'plan',  // Claude modes
            'read-only', 'safe-yolo', 'yolo'  // Codex modes
        ];

        it('returns a valid Claude mode for every PermissionMode', () => {
            const validClaudeModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];

            allModes.forEach(mode => {
                const result = mapToClaudeMode(mode);
                expect(validClaudeModes).toContain(result);
            });
        });
    });
});

describe('resolveClaudeSdkPermissionModeFromEnhancedMode', () => {
    it('forces plan when agentModeId=plan (even if permissionMode is read-only)', () => {
        expect(
            resolveClaudeSdkPermissionModeFromEnhancedMode({
                permissionMode: 'read-only',
                agentModeId: 'plan',
            }),
        ).toBe('plan');
    });
});

describe('normalizeClaudeHappyCliSessionControlPermissionMode', () => {
    it('keeps safe-yolo as a Happier CLI intent so Unified can launch Claude in auto mode', () => {
        expect(normalizeClaudeHappyCliSessionControlPermissionMode('safe-yolo')).toBe('safe-yolo');
    });
});
