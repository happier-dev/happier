export type SessionTagColorRole = 'slate' | 'blue' | 'green' | 'amber' | 'violet' | 'rose' | 'teal' | 'neutral';
export type SessionTagChipColors = Readonly<{ backgroundColor: string; borderColor: string; color: string }>;

const TAG_COLOR_ROLES: readonly Exclude<SessionTagColorRole, 'neutral'>[] = ['slate', 'blue', 'green', 'amber', 'violet', 'rose', 'teal'];

// Tags need more variety than status colours provide. This domain palette stays quiet in both themes.
const LIGHT_TAG_COLORS: Readonly<Record<SessionTagColorRole, SessionTagChipColors>> = {
    slate: { backgroundColor: '#F1F4F6', borderColor: '#D9E0E5', color: '#60707A' }, blue: { backgroundColor: '#F0F5FC', borderColor: '#D3DFEF', color: '#607AA6' }, green: { backgroundColor: '#F0F7F1', borderColor: '#D4E5D7', color: '#5C8065' }, amber: { backgroundColor: '#FCF7ED', borderColor: '#E9DEC5', color: '#8B7345' }, violet: { backgroundColor: '#F5F2F9', borderColor: '#E0D8EC', color: '#77658E' }, rose: { backgroundColor: '#FBF2F3', borderColor: '#ECD6DA', color: '#946773' }, teal: { backgroundColor: '#EEF7F6', borderColor: '#D0E5E1', color: '#5C807B' }, neutral: { backgroundColor: '#F5F5F5', borderColor: '#E2E2E2', color: '#777777' },
};
const DARK_TAG_COLORS: Readonly<Record<SessionTagColorRole, SessionTagChipColors>> = {
    slate: { backgroundColor: '#22282A', borderColor: '#303A3D', color: '#A0AFB5' }, blue: { backgroundColor: '#202938', borderColor: '#303F56', color: '#9AADD1' }, green: { backgroundColor: '#202D25', borderColor: '#304035', color: '#98B8A0' }, amber: { backgroundColor: '#302B22', borderColor: '#433B2D', color: '#C1AD81' }, violet: { backgroundColor: '#292430', borderColor: '#3B3345', color: '#B3A2C5' }, rose: { backgroundColor: '#312427', borderColor: '#453136', color: '#C29AA4' }, teal: { backgroundColor: '#202C2B', borderColor: '#30403E', color: '#97B9B4' }, neutral: { backgroundColor: '#252323', borderColor: '#343131', color: '#A49D98' },
};

export function resolveSessionTagColorRole(label: string, isOverflow = false): SessionTagColorRole {
    if (isOverflow) return 'neutral';

    let hash = 5381;
    for (const char of label.trim().toLocaleLowerCase()) {
        hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
    }
    return TAG_COLOR_ROLES[hash % TAG_COLOR_ROLES.length];
}

export function resolveSessionTagChipColors(label: string, isOverflow: boolean, isDark: boolean): SessionTagChipColors {
    return (isDark ? DARK_TAG_COLORS : LIGHT_TAG_COLORS)[resolveSessionTagColorRole(label, isOverflow)];
}
