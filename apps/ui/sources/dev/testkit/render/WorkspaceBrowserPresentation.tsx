import * as React from 'react';
import { ScrollViewStyleReset } from 'expo-router/html';

import { installWebFontFaces } from '@/platform/installWebFontFaces';

const fontNames = [
    'Inter-Regular', 'Inter-Italic', 'Inter-Medium', 'Inter-SemiBold',
    'IBMPlexMono-Regular', 'IBMPlexMono-Italic', 'IBMPlexMono-SemiBold',
    'BricolageGrotesque-Bold', 'SpaceMono-Regular',
];
const fontMap = Object.fromEntries(fontNames.map(name => [name === 'SpaceMono-Regular' ? 'SpaceMono' : name, `/fonts/${name}.ttf`]));

/** The real Expo viewport reset and app font owner precede source-driven browser surfaces. */
export function WorkspaceBrowserPresentation(props: Readonly<{ children: React.ReactNode }>) {
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
        let current = true;
        void installWebFontFaces(fontMap).then(() => { if (current) setReady(true); });
        return () => { current = false; };
    }, []);
    return <><ScrollViewStyleReset />{ready ? props.children : null}</>;
}
