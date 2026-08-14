import type { ReactNode } from 'react';

import { TerminalBackground } from './TerminalBackground';
import { ThemeProvider } from './ThemeContext';
import { Footer } from '../sections/Footer';
import { Nav } from '../sections/Nav';

/**
 * Chrome for every route that is not the homepage.
 *
 * The homepage puts <Nav /> inside <Hero /> because the nav floats over the
 * planet image. Every other route has no hero, so the nav needs its own band at
 * the top of the document — same component, `variant="static"`, so there is one
 * nav in the codebase and not two that drift.
 *
 * `isHome={false}` is what rewrites the in-page anchors (#get-started,
 * #features) to `/#get-started`. Without it every nav link on /agents scrolls to
 * a fragment that does not exist on that page, which is the single most common
 * way a one-page site breaks when it grows a second page.
 */
export function PageShell({ children }: { children: ReactNode }) {
    return (
        <ThemeProvider>
            <div className="relative min-h-screen">
                <TerminalBackground />
                <div className="relative z-[2]">
                    <Nav variant="static" isHome={false} />
                    <main>{children}</main>
                    <Footer isHome={false} />
                </div>
            </div>
        </ThemeProvider>
    );
}

/**
 * The standard page header for a content route: eyebrow, H1, standfirst.
 *
 * Deliberately NOT <RevealText>. The word-by-word reveal is a hero device; on a
 * reference page it delays the one line the visitor came to read, and these
 * pages are read by machines at least as often as by people.
 */
export function PageHeader({
    eyebrow,
    title,
    standfirst,
}: {
    eyebrow: string;
    title: string;
    standfirst: ReactNode;
}) {
    return (
        <header className="mx-auto max-w-[1400px] px-6 pb-10 pt-16 md:px-10 md:pb-14 md:pt-24">
            <div className="max-w-[880px]">
                <div
                    className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                    style={{ color: 'var(--muted)' }}
                >
                    {eyebrow}
                </div>
                <h1 className="font-display text-[36px] font-normal leading-[1.05] tracking-[-0.03em] md:text-[52px] lg:text-[60px]">
                    {title}
                </h1>
                <p
                    className="mt-6 max-w-[720px] text-[17px] leading-[1.62] md:text-[19px]"
                    style={{ color: 'var(--muted)' }}
                >
                    {standfirst}
                </p>
            </div>
        </header>
    );
}

/** A titled band of body copy. `id` becomes the deep-link anchor. */
export function Prose({
    id,
    heading,
    children,
    'data-section': dataSection,
}: {
    id?: string;
    heading?: string;
    children: ReactNode;
    'data-section'?: string;
}) {
    return (
        <section id={id} data-section={dataSection} className="relative">
            <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                <div className="max-w-[760px]">
                    {heading ? (
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                            {heading}
                        </h2>
                    ) : null}
                    <div className="mt-5 space-y-5">{children}</div>
                </div>
            </div>
        </section>
    );
}

export function P({ children }: { children: ReactNode }) {
    return (
        <p className="text-[16px] leading-[1.68] md:text-[17px]" style={{ color: 'var(--muted)' }}>
            {children}
        </p>
    );
}
