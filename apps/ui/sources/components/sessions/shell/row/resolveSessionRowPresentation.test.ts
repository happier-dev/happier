import { describe, expect, it } from 'vitest';

import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import {
    shouldEmphasizeSessionRowTitle,
    shouldShowMinimalSessionStatusLine,
} from './resolveSessionRowPresentation';

function createSessionStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
    return {
        state: 'waiting',
        isConnected: true,
        statusText: 'online',
        shouldShowStatus: false,
        statusColor: '#0f0',
        statusDotColor: '#0f0',
        isPulsing: false,
        ...overrides,
    };
}

describe('resolveSessionRowPresentation', () => {
    it('does not emphasize a quiet viewed waiting session title', () => {
        expect(shouldEmphasizeSessionRowTitle({
            hasUnreadMessages: false,
            pendingCount: 0,
            sessionStatus: createSessionStatus(),
        })).toBe(false);
    });

    it('emphasizes the title when the session has unread messages', () => {
        expect(shouldEmphasizeSessionRowTitle({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionStatus: createSessionStatus(),
        })).toBe(true);
    });

    it('emphasizes the title when the session needs user attention', () => {
        expect(shouldEmphasizeSessionRowTitle({
            hasUnreadMessages: false,
            pendingCount: 0,
            sessionStatus: createSessionStatus({
                state: 'permission_required',
                shouldShowStatus: true,
                statusText: 'Permission required',
            }),
        })).toBe(true);
    });

    it('shows a minimal-row status line only for meaningful active states', () => {
        expect(shouldShowMinimalSessionStatusLine(
            createSessionStatus({
                state: 'thinking',
                shouldShowStatus: true,
                statusText: 'Working on it',
            }),
        )).toBe(true);
    });

    it('hides a minimal-row status line for quiet online sessions', () => {
        expect(shouldShowMinimalSessionStatusLine(createSessionStatus())).toBe(false);
    });
});
