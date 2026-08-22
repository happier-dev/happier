import { useEffect, useRef, useState } from 'react';

import { LOCALES, LOCALE_META, pathForLocale, useI18n } from '../i18n';
import { useTheme } from '../islands/themeStore';

/**
 * The language picker in the footer.
 *
 * Ten links laid flat across a footer column read as ten more destinations
 * competing with Product / Open source / Resources, when they are one control
 * with ten settings. It collapses to a single trigger showing the current
 * language, styled to match the desktop-download popover in DownloadBadges.tsx —
 * same blurred panel, same rounded rows, same chevron.
 *
 * BUILT ON <details>, NOT ON useState, AND THAT IS THE WHOLE POINT.
 *
 * The obvious implementation renders the panel only while open, exactly as the
 * download popover does. That is right there and wrong here: those are external
 * links to GitHub releases, while these are the site's own language alternates.
 * A panel that exists only after a click is a panel whose links are not in the
 * prerendered HTML — so a crawler never sees them, and a reader whose bundle
 * failed to load has no way to reach their own language.
 *
 * `<details>` keeps every link in the markup, open or shut, and opens without
 * JavaScript. React only ENHANCES it: Escape to close, click-outside to close,
 * close after a choice. Strip the JS and it is still a working language menu.
 *
 * The `<summary>` marker is removed in both engines (`list-style: none` for
 * standards, `::-webkit-details-marker` for older Safari) so nothing about it
 * reads as a native disclosure triangle.
 *
 * IT OFFERS EVERY LOCALE BECAUSE EVERY ROUTE HAS EVERY LOCALE. It cannot ask the
 * route: `findRoute()` lives in src/routes.tsx, which statically imports all
 * nine page components and every data module, and this footer renders on all 210
 * pages — importing it here would pull the whole site into the chunk every page
 * shares and undo the bundle split. The invariant is asserted instead, in
 * src/i18n/localeSwitcher.test.ts, which fails naming the route rather than
 * letting this link to a page the build never wrote.
 */
export function LocaleSwitcher() {
    const { locale: current, path } = useI18n();
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const ref = useRef<HTMLDetailsElement | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const close = () => {
            setOpen(false);
            if (ref.current) ref.current.open = false;
        };
        const onPointerDown = (event: MouseEvent) => {
            if (!ref.current?.contains(event.target as Node)) close();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    const currentMeta = LOCALE_META[current];

    return (
        <details
            ref={ref}
            data-section="locale-switcher"
            className="relative inline-block"
            onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
            <summary
                aria-label={`Language: ${currentMeta.englishName}`}
                className="inline-flex cursor-pointer list-none items-center gap-2 rounded-full border px-3.5 py-2 text-[14px] transition-opacity hover:opacity-100 [&::-webkit-details-marker]:hidden"
                style={{ borderColor: 'var(--card-border)', color: 'var(--fg)', opacity: 0.85 }}
            >
                <GlobeIcon />
                <span lang={currentMeta.htmlLang}>{currentMeta.nativeName}</span>
                <ChevronIcon open={open} />
            </summary>

            <div
                role="menu"
                className="absolute bottom-full left-0 z-50 mb-2 max-h-[60vh] min-w-[210px] overflow-auto rounded-2xl border p-1.5"
                style={{
                    background: isDark ? 'rgba(15,15,18,0.92)' : 'rgba(252,250,245,0.96)',
                    borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(10,10,11,0.08)',
                    backdropFilter: 'blur(24px)',
                    WebkitBackdropFilter: 'blur(24px)',
                    boxShadow: isDark
                        ? '0 24px 60px -10px rgba(0,0,0,0.6)'
                        : '0 24px 60px -10px rgba(10,10,11,0.18)',
                }}
            >
                {LOCALES.map((locale) => {
                    const meta = LOCALE_META[locale];
                    const isCurrent = locale === current;
                    return (
                        <a
                            key={locale}
                            href={pathForLocale(locale, path)}
                            // hreflang is not decoration: it tells a crawler what
                            // is on the other end before it follows, which is what
                            // makes this a language annotation rather than ten
                            // links to near-duplicate pages.
                            hrefLang={meta.htmlLang}
                            lang={meta.htmlLang}
                            role="menuitem"
                            aria-current={isCurrent ? 'true' : undefined}
                            onClick={() => setOpen(false)}
                            className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-[14px] transition-opacity hover:opacity-100"
                            style={{
                                color: 'var(--fg)',
                                opacity: isCurrent ? 1 : 0.75,
                                fontWeight: isCurrent ? 600 : 400,
                                background: isCurrent
                                    ? isDark
                                        ? 'rgba(255,255,255,0.06)'
                                        : 'rgba(10,10,11,0.05)'
                                    : undefined,
                            }}
                        >
                            <span>{meta.nativeName}</span>
                            {isCurrent ? <CheckIcon /> : null}
                        </a>
                    );
                })}
            </div>
        </details>
    );
}

function GlobeIcon() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            aria-hidden
            className="h-4 w-4 shrink-0"
        >
            <circle cx="8" cy="8" r="6.2" />
            <path d="M2 8h12M8 1.8c1.6 1.7 2.4 3.8 2.4 6.2S9.6 12.5 8 14.2C6.4 12.5 5.6 10.4 5.6 8S6.4 3.5 8 1.8Z" />
        </svg>
    );
}

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 transition-transform duration-200"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
            <path d="M4 6l4 4 4-4" />
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="h-3.5 w-3.5 shrink-0"
        >
            <path d="M3.5 8.5l3 3 6-7" />
        </svg>
    );
}
