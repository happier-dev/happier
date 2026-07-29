import { describe, expect, it } from 'vitest';

import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import {
    shouldEmphasizeSessionRowTitle,
    shouldShowMinimalSessionStatusLine,
} from './resolveSessionRowPresentation';

type SessionRowAttentionState =
    | 'quiet'
    | 'unread'
    | 'pending'
    | 'working'
    | 'ready'
    | 'failed'
    | 'permission_required'
    | 'action_required';

type ResolveSessionRowPresentation = (input: Readonly<{
    attentionState: SessionRowAttentionState;
    density: 'default' | 'compact' | 'minimal';
    requestedSecondaryLineMode: 'status' | 'path';
    hasPathSubtitle: boolean;
    workingRetained?: boolean;
    backgroundActive?: boolean;
}>) => Readonly<{
    attentionIndicator: 'none' | 'working' | 'ready' | 'failed' | 'unread' | 'pending' | 'permission' | 'action';
    titleTone: 'quiet' | 'normal' | 'emphasized';
    secondaryLine: 'none' | 'path' | 'status';
    statusTextKey?: 'status.readyForReview' | 'status.error' | 'status.workingRetained' | 'status.backgroundActive';
}>;

async function loadRowPresentationResolver(): Promise<ResolveSessionRowPresentation> {
    const module = await import('./resolveSessionRowPresentation');
    const resolver = (module as Partial<{
        resolveSessionRowPresentation: ResolveSessionRowPresentation;
    }>).resolveSessionRowPresentation;
    expect(resolver).toBeTypeOf('function');
    return resolver as ResolveSessionRowPresentation;
}

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

    it('hides minimal-row status text for working states because the indicator owns attention', () => {
        expect(shouldShowMinimalSessionStatusLine(
            createSessionStatus({
                state: 'thinking',
                shouldShowStatus: true,
                statusText: 'Working on it',
            }),
        )).toBe(false);
    });

    it('hides a minimal-row status line for quiet online sessions', () => {
        expect(shouldShowMinimalSessionStatusLine(createSessionStatus())).toBe(false);
    });

    it('keeps minimal working rows to an indicator without a secondary line', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

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

    it('uses a ready-for-review status subtitle for non-minimal ready rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

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

    it('uses an error status subtitle for non-minimal failed rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'failed',
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        })).toEqual({
            attentionIndicator: 'failed',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.error',
        });
    });

    it('gives retained working rows a dedicated status text instead of live status', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

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

    it('does not apply the retained status text to live working rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

        expect(resolveSessionRowPresentation({
            attentionState: 'working',
            workingRetained: false,
            density: 'default',
            requestedSecondaryLineMode: 'path',
            hasPathSubtitle: true,
        }).statusTextKey).toBeUndefined();
    });

    it('uses the normal working spinner and precise background copy without replacing actionable indicators', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

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
            statusTextKey: 'status.backgroundActive',
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
            statusTextKey: 'status.backgroundActive',
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
            statusTextKey: 'status.backgroundActive',
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
        })).toEqual({
            attentionIndicator: 'action',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        });
        expect(resolveSessionRowPresentation({
            attentionState: 'failed',
            backgroundActive: true,
            density: 'default',
            requestedSecondaryLineMode: 'status',
            hasPathSubtitle: false,
        })).toEqual({
            attentionIndicator: 'failed',
            titleTone: 'emphasized',
            secondaryLine: 'status',
            statusTextKey: 'status.error',
        });
    });

    it('uses the working spinner for background activity in minimal rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

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

    it('does not show online status text for quiet rows', async () => {
        const resolveSessionRowPresentation = await loadRowPresentationResolver();

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
});
