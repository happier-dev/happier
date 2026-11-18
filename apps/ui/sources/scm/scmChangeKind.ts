import type { ScmEntryKind } from '@/sync/domains/state/storageTypes';

/**
 * What a change is, as the letter every surface shows (Git rows, the Files tree, folder marks) and
 * the tone it is drawn in. Untracked reads as added: it is new content that a commit will include.
 */
export type ScmChangeTone = 'modified' | 'added' | 'deleted' | 'moved' | 'conflicted';

export type ScmChangeDescriptor = Readonly<{ code: string; tone: ScmChangeTone }>;

const DESCRIPTORS: Readonly<Record<ScmEntryKind, ScmChangeDescriptor>> = {
    modified: { code: 'M', tone: 'modified' },
    added: { code: 'A', tone: 'added' },
    untracked: { code: 'A', tone: 'added' },
    deleted: { code: 'D', tone: 'deleted' },
    renamed: { code: 'R', tone: 'moved' },
    copied: { code: 'C', tone: 'moved' },
    conflicted: { code: '!', tone: 'conflicted' },
};

const TONE_BY_CODE: Readonly<Record<string, ScmChangeTone>> = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'moved',
    C: 'moved',
    '!': 'conflicted',
};

export function normalizeScmChangeKind(kind: string): ScmEntryKind {
    return Object.prototype.hasOwnProperty.call(DESCRIPTORS, kind) ? kind as ScmEntryKind : 'modified';
}

export function describeScmChangeKind(kind: string): ScmChangeDescriptor {
    return DESCRIPTORS[normalizeScmChangeKind(kind)];
}

/** The tone of a letter a summary already carries (a folder's dominant change). */
export function resolveScmChangeToneForCode(code: string): ScmChangeTone {
    return TONE_BY_CODE[code] ?? 'modified';
}

type ScmChangeToneTheme = Readonly<{
    colors: Readonly<{
        text: Readonly<{ secondary: string; link?: string }>;
        state: Readonly<{
            success: Readonly<{ textForeground?: string }>;
            neutral: Readonly<{ textForeground?: string }>;
            danger: Readonly<{ textForeground?: string }>;
            warning?: Readonly<{ textForeground?: string }>;
        }>;
    }>;
}>;

export function resolveScmChangeToneColor(tone: ScmChangeTone, theme: ScmChangeToneTheme): string {
    const fallback = theme.colors.text.secondary;
    switch (tone) {
        case 'added':
            return theme.colors.state.success.textForeground ?? fallback;
        case 'deleted':
        case 'conflicted':
            return theme.colors.state.danger.textForeground ?? fallback;
        case 'moved':
            return theme.colors.text.link ?? fallback;
        case 'modified':
        default:
            // Lab tone: modified reads amber (warning), the one hue that means "edited".
            return theme.colors.state.warning?.textForeground ?? theme.colors.state.neutral.textForeground ?? fallback;
    }
}
