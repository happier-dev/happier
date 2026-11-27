import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GitHubStarPill } from '../components/GitHubStarPill';
import { LocaleProvider } from '../i18n';
import { Nav } from './Nav';

describe('GitHub stars', () => {
    it('renders the same star count in the header and the Open pill before hydration', () => {
        const render = (content: React.ReactNode) => renderToString(
            <LocaleProvider locale="en" path="/open">{content}</LocaleProvider>,
        );
        const header = render(<Nav variant="static" isHome={false} />);
        const pill = render(<GitHubStarPill />);
        const count = pill.match(/class="rollnum">([\d,]+)<\/span>/)?.[1];
        expect(count).toBeDefined();
        expect(header).toContain(`>${count}</span>`);
    });
});
