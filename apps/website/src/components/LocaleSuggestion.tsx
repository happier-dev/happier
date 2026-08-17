import { useEffect, useState } from 'react';

import { LOCALE_META, pathForLocale, suggestLocale, useI18n, type Locale } from '../i18n';

const DISMISSED_KEY = 'happier.locale.dismissed';
const CHOSEN_KEY = 'happier.locale.chosen';

/**
 * "This page is also in your language" — a dismissible offer, never a redirect.
 *
 * WHY THIS IS NOT AN AUTOMATIC SWITCH, which is the obvious implementation and
 * the wrong one:
 *
 *   Googlebot crawls predominantly from US IPs sending `Accept-Language: en-US`.
 *   A `/` that redirects by language shows the crawler English and only English,
 *   so the other nine locales may never be indexed — which would defeat the
 *   entire hreflang cluster this site now emits. Google's own guidance is to
 *   serve the requested URL and let the reader choose.
 *
 *   And a reader who deliberately chose English gets thrown back into Chinese on
 *   every visit, with no obvious way out. The banner is that way out, and the
 *   footer switcher is the other one.
 *
 * NOTHING RENDERS ON THE SERVER. It returns null until an effect has run,
 * because it depends on `navigator.languages` and on localStorage, neither of
 * which exists during the prerender — and the prerendered HTML is one file
 * served to every reader of that URL from a CDN, so a guess baked into it would
 * be wrong for most of them. The first paint is therefore identical with and
 * without this component, and hydration has nothing to disagree about.
 */
export function LocaleSuggestion() {
    const { locale: current, path } = useI18n();
    const [suggested, setSuggested] = useState<Locale | null>(null);

    useEffect(() => {
        try {
            // An explicit choice, in either direction, ends the conversation.
            // Dismissing is a choice; so is having used the switcher.
            if (localStorage.getItem(DISMISSED_KEY) === '1') return;
            if (localStorage.getItem(CHOSEN_KEY)) return;
        } catch {
            // Safari in private mode throws on localStorage. A reader who
            // cannot be remembered should still not be nagged into a redirect,
            // so the banner simply shows and dismissal lasts the session.
        }

        const languages = navigator.languages?.length
            ? [...navigator.languages]
            : [navigator.language].filter(Boolean);
        setSuggested(suggestLocale(current, languages));
    }, [current]);

    if (!suggested) return null;

    const meta = LOCALE_META[suggested];

    const remember = (key: string, value: string) => {
        try {
            localStorage.setItem(key, value);
        } catch {
            /* see the note above — not being able to remember is not an error */
        }
    };

    return (
        <div
            data-section="locale-suggestion"
            className="border-b"
            style={{ borderColor: 'var(--card-border)', background: 'var(--card)' }}
        >
            <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 md:px-10">
                {/*
                    Every string here is in the language being OFFERED, and
                    `lang` says so on each node — a screen reader has to switch
                    voice for this one line, and a Spanish sentence announced in
                    an English voice is worse than no banner.
                */}
                <p className="text-[14px]" style={{ color: 'var(--fg)' }} lang={meta.htmlLang}>
                    {meta.suggestion.offer}
                </p>
                <a
                    href={pathForLocale(suggested, path)}
                    hrefLang={meta.htmlLang}
                    lang={meta.htmlLang}
                    onClick={() => remember(CHOSEN_KEY, suggested)}
                    className="text-[14px] font-medium underline underline-offset-2"
                    style={{ color: 'var(--fg)' }}
                >
                    {meta.suggestion.action}
                </a>
                <button
                    type="button"
                    aria-label={meta.suggestion.dismiss}
                    lang={meta.htmlLang}
                    onClick={() => {
                        remember(DISMISSED_KEY, '1');
                        setSuggested(null);
                    }}
                    className="ml-auto text-[13px] transition-opacity hover:opacity-100"
                    style={{ color: 'var(--muted)', opacity: 0.8 }}
                >
                    <span aria-hidden="true">✕</span>
                </button>
            </div>
        </div>
    );
}
