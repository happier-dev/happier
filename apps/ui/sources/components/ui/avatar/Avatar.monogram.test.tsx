import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { Avatar } = await import('./Avatar');

describe('Avatar monogram presentation', () => {
    it.each([undefined, 'https://example.test/logo.png'])('keeps an unnamed avatar decorative (%s)', async imageUrl => {
        const screen = await renderScreen(<Avatar id="account-1" imageUrl={imageUrl} testID="decoration" size={28} />);
        expect(screen.findByTestId('decoration')?.props.accessibilityRole).toBeUndefined();
    });
    afterEach(() => {
        standardCleanup();
    });

    it('adds a deterministic first-grapheme monogram over the generated identity', async () => {
        const screen = await renderScreen(<Avatar id="équipe-1" title square size={48} />);

        const monogram = screen.findByTestId('avatar-monogram');
        expect(monogram).not.toBeNull();
        expect(monogram?.props.children).toBe('É');
    });

    it('takes the monogram from the given name while the id keeps seeding the artwork', async () => {
        const screen = await renderScreen(<Avatar id="cmv3nqbzj001em2z0qa1ivc5p" monogram="Platform Infrastructure" square size={44} />);

        expect(screen.findByTestId('avatar-monogram')?.props.children).toBe('P');
    });

    it('does not cover a published image with the generated monogram', async () => {
        const screen = await renderScreen(
            <Avatar id="team-1" title imageUrl="https://example.test/logo.png" square size={48} />,
        );

        expect(screen.findByTestId('avatar-monogram')).toBeNull();
    });

    it('names the avatar image and preserves its host selector', async () => {
        const screen = await renderScreen(<Avatar id="account-1" accessibilityLabel="Ana" testID="person" size={28} />);
        expect(screen.findByTestId('person')?.props.accessibilityRole).toBe('image');
        expect(screen.findByTestId('person')?.props.accessibilityLabel).toBe('Ana');
    });
});
