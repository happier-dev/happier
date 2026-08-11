import { describe, expect, it } from 'vitest';

import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import {
    resolveLegacySessionRowAttentionState,
    resolveSessionRowAttentionState,
    resolveSessionRowPresentation,
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
                statusText: 'working on it',
            }),
        )).toBe(false);
    });

    it('hides a minimal-row status line for quiet online sessions', () => {
        expect(shouldShowMinimalSessionStatusLine(createSessionStatus())).toBe(false);
    });

    it('maps legacy thinking status to a working attention indicator', () => {
        expect(resolveLegacySessionRowAttentionState({
            hasUnreadMessages: false,
            pendingCount: 0,
            sessionStatus: createSessionStatus({
                state: 'thinking',
                shouldShowStatus: true,
                statusText: 'working on it',
            }),
        })).toBe('working');
    });

    it('maps canonical list thinking attention to product working presentation', () => {
        expect(resolveSessionRowAttentionState('thinking')).toBe('working');
    });

    it('keeps minimal working rows to a left indicator without a status line', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'working',
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'none',
        });
    });

    it('keeps active work visible when the row prefers a path subtitle', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'working',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        });
    });

    it('gives retained working rows a dedicated status text instead of live status', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'working',
            workingRetained: true,
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.workingRetained',
        });
    });

    it('does not apply the retained status text to live working rows', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'working',
            workingRetained: false,
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        }).statusTextKey).toBeUndefined();
    });

    it('keeps blocked active work visible when the row prefers a path subtitle', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'permission_required',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'permission',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'action_required',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'action',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        });
    });

    it('does not request status UI for quiet online rows', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'none',
            titleTone: 'quiet',
            secondaryLine: 'none',
        });
    });

    it('requests a ready subtitle for non-minimal ready rows', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'ready',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'ready',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.readyForReview',
        });
    });

    it('requests an error subtitle for non-minimal failed rows', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'failed',
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'failed',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.error',
        });
    });

    it('uses the normal working indicator for background activity while retaining precise status and higher-priority attention', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'unread',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            backgroundActivityStatusLine: true,
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'pending',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            backgroundActivityStatusLine: true,
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'ready',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            backgroundActivityStatusLine: true,
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'permission_required',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'permission',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'action_required',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        }).attentionIndicator).toBe('action');
        expect(resolveSessionRowPresentation({
            attentionState: 'failed',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        }).attentionIndicator).toBe('failed');
    });

    it('uses the normal working indicator without a secondary line in minimal background-active rows', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            backgroundActive: true,
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'quiet',
            secondaryLine: 'none',
        });
    });

    it('keeps a quiet background-active row title quiet while showing the working indicator', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'quiet',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'working',
            titleTone: 'quiet',
            secondaryLine: 'status',
            backgroundActivityStatusLine: true,
        });
    });

    it('keeps ready minimal rows to the left indicator', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'ready',
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'ready',
            titleTone: 'emphasized',
            secondaryLine: 'none',
        });
    });

    it('uses distinct indicator variants for blocked attention states', () => {
        expect(resolveSessionRowPresentation({
            attentionState: 'permission_required',
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        }).attentionIndicator).toBe('permission');
        expect(resolveSessionRowPresentation({
            attentionState: 'action_required',
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        }).attentionIndicator).toBe('action');
        expect(resolveSessionRowPresentation({
            attentionState: 'failed',
            density: 'minimal',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        }).attentionIndicator).toBe('failed');
    });
});
