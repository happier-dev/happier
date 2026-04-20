import { describe, it, expect } from 'vitest';
import {
    mapToClaudeMode,
    normalizeClaudeHappyCliSessionControlPermissionMode,
    resolveClaudeSdkPermissionModeFromEnhancedMode,
} from './permissionMode';
import type { PermissionMode } from '@/api/types';

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
    it('maps yolo to bypassPermissions at the Happier CLI session-control boundary', () => {
        expect(normalizeClaudeHappyCliSessionControlPermissionMode('yolo')).toBe('bypassPermissions');
    });

    it('maps safe-yolo to acceptEdits at the Happier CLI session-control boundary', () => {
        expect(normalizeClaudeHappyCliSessionControlPermissionMode('safe-yolo')).toBe('acceptEdits');
    });

    it('preserves read-only at the Happier CLI session-control boundary', () => {
        expect(normalizeClaudeHappyCliSessionControlPermissionMode('read-only')).toBe('read-only');
    });
});
