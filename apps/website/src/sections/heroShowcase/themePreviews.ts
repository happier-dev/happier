export type ThemePreview = {
    id: string;
    src: string;
    swatch: string;
    label: string;
};

export const MOBILE_THEME_PREVIEWS: ThemePreview[] = [
    {
        id: 'midnight-indigo',
        src: '/images/demo/screenshots/ios-themes/1.png',
        swatch: '#131111',
        label: 'Midnight indigo theme',
    },
    {
        id: 'warm-graphite',
        src: '/images/demo/screenshots/ios-themes/2.png',
        swatch: '#181926',
        label: 'Warm graphite theme',
    },
    {
        id: 'slate-blue',
        src: '/images/demo/screenshots/ios-themes/3.png',
        swatch: '#050506',
        label: 'Slate blue theme',
    },
    {
        id: 'true-black',
        src: '/images/demo/screenshots/ios-themes/4.png',
        swatch: '#21252B',
        label: 'True black theme',
    },
    {
        id: 'deep-navy',
        src: '/images/demo/screenshots/ios-themes/5.png',
        swatch: '#0D1117',
        label: 'Deep navy theme',
    },
    {
        id: 'paper',
        src: '/images/demo/screenshots/ios-themes/6.png',
        swatch: '#F5F5F5',
        label: 'Paper light theme',
    },
    {
        id: 'mist',
        src: '/images/demo/screenshots/ios-themes/7.png',
        swatch: '#EFF1F5',
        label: 'Mist light theme',
    },
    {
        id: 'warm-ivory',
        src: '/images/demo/screenshots/ios-themes/8.png',
        swatch: '#F8F8F2',
        label: 'Warm ivory theme',
    },
];

export function resolveNextThemePreviewIndex(currentIndex: number, total: number): number {
    if (total <= 0) return 0;
    return (currentIndex + 1) % total;
}
