export type SessionTagColorRole = 'active' | 'info' | 'success' | 'warning' | 'neutral';

const TAG_COLOR_ROLES: readonly Exclude<SessionTagColorRole, 'neutral'>[] = [
    'active',
    'info',
    'success',
    'warning',
];

export function resolveSessionTagColorRole(label: string, isOverflow = false): SessionTagColorRole {
    if (isOverflow) return 'neutral';

    let hash = 0;
    for (const char of label.trim().toLocaleLowerCase()) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return TAG_COLOR_ROLES[hash % TAG_COLOR_ROLES.length];
}
