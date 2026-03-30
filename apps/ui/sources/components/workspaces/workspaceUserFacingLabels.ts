import type {
    WorkspaceCheckoutKind,
} from '@happier-dev/protocol';

import { t } from '@/text';

function titleCaseLabel(value: string): string {
    return value.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function humanizeWorkspaceValue(value: string): string {
    const normalized = value.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
    return normalized.length > 0 ? titleCaseLabel(normalized) : t('common.unavailable');
}

export function resolveWorkspaceCheckoutKindLabel(kind: WorkspaceCheckoutKind | string): string {
    switch (kind) {
        case 'primary':
            return t('workspacePresentation.checkoutKinds.primary');
        case 'git_worktree':
            return t('workspacePresentation.checkoutKinds.git_worktree');
        default:
            return humanizeWorkspaceValue(kind);
    }
}
