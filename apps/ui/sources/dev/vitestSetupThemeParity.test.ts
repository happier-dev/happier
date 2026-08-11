import { useUnistyles } from 'react-native-unistyles';
import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';

/**
 * `vitestSetup.ts` supplies the theme every rendered component reads under Vitest. It deliberately
 * cannot import `@/theme`: 450+ test files install their own partial `react-native` mock, and
 * evaluating the real theme's `Platform.select` against one of those would break them. The
 * `state.*` palette is therefore owned by a `react-native`-free module that both the real theme and
 * the mock consume.
 *
 * This is the guard on that arrangement. A token added to the real theme and forgotten in the mock
 * resolves to `undefined`, which renders as "no colour" and passes silently — the vacuous green this
 * program is specifically trying not to reintroduce. A token *restated* with a different value is
 * worse than absent: it renders a colour the app never paints, and every assertion about it is a
 * confident lie. `text.*` and `surface.*` are guarded alongside `state.*` because they are the two
 * other blocks the whole app reads and neither needs `react-native` to resolve.
 */
describe('vitest unistyles theme mock', () => {
    it('serves the real state palette to rendered components', () => {
        const { theme } = useUnistyles();

        expect(theme.colors.state).toEqual(lightTheme.colors.state);
    });

    it('serves the real text palette to rendered components', () => {
        const { theme } = useUnistyles();

        expect(theme.colors.text).toEqual(lightTheme.colors.text);
    });

    it('serves the real surface palette to rendered components', () => {
        const { theme } = useUnistyles();

        expect(theme.colors.surface).toEqual(lightTheme.colors.surface);
    });
});
