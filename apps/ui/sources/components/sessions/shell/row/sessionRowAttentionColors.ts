import type { Theme } from '@/theme';
import type {
    SessionRowAttentionIndicator,
    SessionRowAttentionState,
} from './resolveSessionRowPresentation';

type SessionRowAttentionColorRole =
    | 'working'
    | 'success'
    | 'danger'
    | 'link'
    | 'warning'
    | 'neutral'
    | 'secondary'
    | 'tertiary';

export function resolveSessionRowAttentionStateColor(
    attentionState: SessionRowAttentionState,
    theme: Theme,
): string {
    return resolveSessionRowAttentionColor(resolveSessionRowAttentionStateColorRole(attentionState), theme);
}

export function resolveSessionRowAttentionIndicatorColor(input: Readonly<{
    indicator: SessionRowAttentionIndicator;
    theme: Theme;
    workingMode?: 'spinner' | 'pulse';
    workingSpinnerTone?: 'info' | 'neutral';
}>): string {
    return resolveSessionRowAttentionColor(resolveSessionRowAttentionIndicatorColorRole(input), input.theme);
}

function resolveSessionRowAttentionStateColorRole(attentionState: SessionRowAttentionState): SessionRowAttentionColorRole {
    switch (attentionState) {
        case 'working':
            return 'working';
        case 'ready':
            return 'success';
        case 'failed':
            return 'danger';
        case 'unread':
            return 'link';
        case 'pending':
            return 'neutral';
        case 'permission_required':
        case 'action_required':
            return 'warning';
        case 'quiet':
            return 'secondary';
    }
}

function resolveSessionRowAttentionIndicatorColorRole(input: Readonly<{
    indicator: SessionRowAttentionIndicator;
    workingMode?: 'spinner' | 'pulse';
    workingSpinnerTone?: 'info' | 'neutral';
}>): SessionRowAttentionColorRole {
    switch (input.indicator) {
        case 'working':
            if (input.workingMode !== 'pulse' && input.workingSpinnerTone === 'neutral') {
                return 'tertiary';
            }
            return 'working';
        case 'ready':
            return 'success';
        case 'failed':
            return 'danger';
        case 'unread':
            return 'link';
        case 'pending':
            return 'neutral';
        case 'permission':
        case 'action':
            return 'warning';
        // Attention standing explains a row that is only in the band because the
        // person put it there. It takes the same muted ink as the sentence beside
        // it — every other marker matches its own status text — so the line reads
        // as one quiet utterance rather than a signal.
        case 'standing':
        case 'none':
            return 'secondary';
    }
}

function resolveSessionRowAttentionColor(role: SessionRowAttentionColorRole, theme: Theme): string {
    switch (role) {
        case 'working':
            return theme.colors.state.info.foreground;
        case 'success':
            return theme.colors.state.success.foreground;
        case 'danger':
            return theme.colors.state.danger.foreground;
        case 'link':
            return theme.colors.text.link;
        case 'warning':
            return theme.colors.state.warning.foreground;
        case 'neutral':
            return theme.colors.state.neutral.foreground;
        case 'secondary':
            return theme.colors.text.secondary;
        case 'tertiary':
            return theme.colors.text.tertiary;
    }
}
