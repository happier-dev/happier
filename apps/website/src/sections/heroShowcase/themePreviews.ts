export type ThemePreview = {
    id: string;
    imageId: `iosTheme${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
    swatch: string;
    label: string;
};

export const MOBILE_THEME_PREVIEWS: ThemePreview[] = [
    {
        id: 'midnight-indigo',
        imageId: 'iosTheme1',
        swatch: '#131111',
        label: 'Midnight indigo theme',
    },
    {
        id: 'warm-graphite',
        imageId: 'iosTheme2',
        swatch: '#181926',
        label: 'Warm graphite theme',
    },
    {
        id: 'slate-blue',
        imageId: 'iosTheme3',
        swatch: '#050506',
        label: 'Slate blue theme',
    },
    {
        id: 'true-black',
        imageId: 'iosTheme4',
        swatch: '#21252B',
        label: 'True black theme',
    },
    {
        id: 'deep-navy',
        imageId: 'iosTheme5',
        swatch: '#0D1117',
        label: 'Deep navy theme',
    },
    {
        id: 'paper',
        imageId: 'iosTheme6',
        swatch: '#F5F5F5',
        label: 'Paper light theme',
    },
    {
        id: 'mist',
        imageId: 'iosTheme7',
        swatch: '#EFF1F5',
        label: 'Mist light theme',
    },
    {
        id: 'warm-ivory',
        imageId: 'iosTheme8',
        swatch: '#F8F8F2',
        label: 'Warm ivory theme',
    },
];

export function resolveNextThemePreviewIndex(currentIndex: number, total: number): number {
    if (total <= 0) return 0;
    return (currentIndex + 1) % total;
}
