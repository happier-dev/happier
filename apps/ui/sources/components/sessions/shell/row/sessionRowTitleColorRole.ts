import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import type { SessionRowTitleTone } from './resolveSessionRowPresentation';

export type SessionListActiveColorModeV1 = 'activityAndAttention' | 'attentionOnly' | 'allActive';
export type SessionRowTitleColorRole = 'primary' | 'secondary' | 'tertiary';

export function normalizeSessionListActiveColorMode(value: unknown): SessionListActiveColorModeV1 {
    return value === 'attentionOnly' || value === 'allActive' ? value : 'activityAndAttention';
}

export function resolveSessionRowTitleColorRole(input: Readonly<{
    mode: SessionListActiveColorModeV1;
    selected: boolean;
    isSessionActive: boolean;
    status: WorkStatusPresentation;
    titleTone: SessionRowTitleTone;
    /** The Bots roster names who is there: a Bot's name is its identity, so activity never greys it. */
    roster?: boolean;
    /** Unread is viewer state the Work status can outrank (offline, stopped), and news must stay findable on those rows. */
    unread?: boolean;
}>): SessionRowTitleColorRole {
    if (input.roster) return 'primary';
    if (input.selected) return 'primary';
    if (input.unread) return 'primary';
    // Calm rows (ruling 2026-11-01): a stopped Session, or one whose Machine is offline, recedes to tertiary ink.
    if (input.status.bucket === 'offline' || input.status.state === 'stopped') return 'tertiary';
    if (input.mode === 'allActive') {
        return input.isSessionActive || input.titleTone !== 'quiet' ? 'primary' : 'secondary';
    }
    if (input.mode === 'attentionOnly') {
        return input.titleTone === 'emphasized' ? 'primary' : 'secondary';
    }
    return input.titleTone === 'quiet' ? 'secondary' : 'primary';
}

/** The ink of a title colour role; Session and Run rows read it here so a state reads the same on both. */
export function sessionRowTitleInk(colors: Readonly<{ text: Readonly<{ primary: string; secondary: string; tertiary: string }> }>,
    role: SessionRowTitleColorRole): string {
    return colors.text[role];
}
