import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { GlassBackedInkContext, useGlassBackedInk, useRetainedGlassBackedInk, type GlassBackedInk } from './glassBackedInk';

let consumerRenders = 0;
function Consumer() {
    consumerRenders += 1;
    return <>{useGlassBackedInk()('#111')}</>;
}
const Quiet = React.memo(Consumer);

function Surface(props: Readonly<{ ink: GlassBackedInk | null }>) {
    const published = useRetainedGlassBackedInk(props.ink);
    return <GlassBackedInkContext.Provider value={published}><Quiet /></GlassBackedInkContext.Provider>;
}

describe('useRetainedGlassBackedInk', () => {
    it('keeps text and icons still when a surface rebuilds an equal ink, and moves them when the ink differs', async () => {
        const make = (secondary: string): GlassBackedInk => ({ themeSecondary: '#111', secondary, quiet: { themeInks: ['#222'], ink: secondary } });
        const screen = await renderScreen(<Surface ink={make('#aaa')} />);
        const settled = consumerRenders;
        await screen.update(<Surface ink={make('#aaa')} />);
        expect(consumerRenders).toBe(settled);
        await screen.update(<Surface ink={make('#bbb')} />);
        expect(consumerRenders).toBe(settled + 1);
    });
});
