// @vitest-environment jsdom

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { SupporterCodeV1Schema } from '../../../../packages/protocol/src/plans/supporterV1';
import { LocaleProvider } from '../i18n';
import { SUPPORTER_CODE_PATTERN, SUPPORTER_CODE_STORAGE_KEY, SupporterCode } from './SupporterCode';

const VALID = '0123456789abcdef0123456789abcdef';

async function mountWith(stored: string | null) {
    if (stored === null) window.localStorage.removeItem(SUPPORTER_CODE_STORAGE_KEY);
    else window.localStorage.setItem(SUPPORTER_CODE_STORAGE_KEY, stored);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            <LocaleProvider locale="en" path="/thanks">
                <SupporterCode />
            </LocaleProvider>,
        ),
    );
    return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
});

describe('/thanks supporter code', () => {
    it('accepts exactly what the protocol schema accepts', () => {
        for (const candidate of [VALID, VALID.toUpperCase(), VALID.slice(1), `${VALID}0`, 'hs_7Kq2xR9mVb3tLpW8', '']) {
            expect(SUPPORTER_CODE_PATTERN.test(candidate), candidate).toBe(SupporterCodeV1Schema.safeParse(candidate).success);
        }
    });

    it('shows the stored code and hands it to the app only through the happier:// link', async () => {
        const { container, unmount } = await mountWith(VALID);
        expect(container.querySelector('code')?.textContent).toBe(VALID);
        const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
        expect(links).toEqual([`happier://settings/plan?supporterCode=${VALID}`]);
        await unmount();
    });

    it('never shows a stored value the app would reject', async () => {
        const { container, unmount } = await mountWith('not-a-supporter-code');
        expect(container.querySelector('code')).toBeNull();
        expect(container.querySelector('a')).toBeNull();
        await unmount();
    });
});
