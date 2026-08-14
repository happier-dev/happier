import { useEffect, useState } from 'react';
import { HappierMark } from '../components/HappierMark';
import { ThemeToggle } from '../components/ThemeToggle';
// Same-origin anchors are deliberately ignored by useLinkClicks (an in-page jump
// is not an exit), so the nav CTA needs its own emitter or it is invisible.
import { trackCtaClicked } from '../analytics/events';

function useGitHubStars(): string | null {
    const [stars, setStars] = useState<string | null>(null);

    useEffect(() => {
        fetch('https://api.github.com/repos/happier-dev/happier', {
            headers: { Accept: 'application/vnd.github.v3+json' },
        })
            .then((r) => r.json())
            .then((data) => {
                const count = data?.stargazers_count;
                if (typeof count === 'number') {
                    setStars(count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
                }
            })
            .catch(() => {});
    }, []);

    return stars;
}

type NavProps = {
    /**
     * `overlay` floats the nav over the hero image (homepage). `static` gives it
     * its own band at the top of a content route, where there is no hero to
     * float over and an absolutely-positioned header would sit on the H1.
     */
    variant?: 'overlay' | 'static';
    /**
     * Homepage-only anchors have to become absolute links everywhere else:
     * `#get-started` on /agents scrolls to nothing, `/#get-started` goes home.
     * This is the bug every one-page site ships the day it grows a second page.
     */
    isHome?: boolean;
};

export function Nav({ variant = 'overlay', isHome = true }: NavProps) {
    const stars = useGitHubStars();

    return (
        <header
            className={variant === 'overlay' ? 'absolute inset-x-0 top-0 z-30' : 'relative z-30 border-b'}
            style={variant === 'static' ? { borderColor: 'var(--card-border)' } : undefined}
            /* Not a `data-section`: the nav is chrome, not a step in the scroll
               funnel, and counting it would make every visit "reach" section 1.
               `data-cta-location` is what useLinkClicks reads. */
            data-cta-location="hero-nav"
        >
            <div
                className={
                    variant === 'overlay'
                        ? 'mx-auto flex max-w-[1400px] items-center justify-between px-6 pt-5 md:px-3 md:pt-7'
                        : 'mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4 md:px-10'
                }
            >
                <HappierMark />

                <div className="flex items-center gap-4 md:gap-5">
                    <a
                        href="https://github.com/happier-dev/happier"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 text-[14px] font-medium transition-opacity hover:opacity-100"
                        style={{ color: 'var(--fg)', opacity: 0.85 }}
                        aria-label="Star on GitHub"
                    >
                        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
                            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                        </svg>
                        <span>GitHub</span>
                        {stars && (
                            <span
                                className="rounded-full border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
                                style={{ borderColor: 'var(--card-border)', color: 'var(--muted)' }}
                            >
                                {stars}
                            </span>
                        )}
                    </a>
                    {/* /agents is the hub for the thirteen per-agent pages, which
                        are what people arrive on from "remote claude code app"
                        and "mobile codex app". It earns the first nav slot
                        because it answers the first question a visitor has:
                        does this run mine? (It used to be pitched
                        here as a capability matrix; that matrix was removed —
                        see src/data/agents.ts.) */}
                    <a
                        href="/agents"
                        className="hidden text-[14px] font-medium transition-opacity hover:opacity-100 md:inline-flex"
                        style={{ color: 'var(--fg)', opacity: 0.85 }}
                    >
                        Agents
                    </a>
                    {/* Enterprise takes the slot Guides used to hold. The link
                        equity that put Guides here in the first place — 53 guides
                        at guides.happier.dev with no inbound link from any Happier
                        surface — is preserved by the Resources column in
                        src/sections/Footer.tsx, which is on every page and is
                        crawled from every one of them. What the nav slot is for is
                        the visitor a footer link never reaches: the one evaluating
                        this for a team, who leaves before they scroll. /enterprise
                        is the only page written for them, and it was reachable from
                        one footer link under Open source.

                        Same md: breakpoint as the rest, so the phone nav stays
                        GitHub + CTA + toggle. */}
                    <a
                        href="/enterprise"
                        className="hidden text-[14px] font-medium transition-opacity hover:opacity-100 md:inline-flex"
                        style={{ color: 'var(--fg)', opacity: 0.85 }}
                    >
                        Enterprise
                    </a>
                    <a
                        href="https://docs.happier.dev"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[14px] font-medium transition-opacity hover:opacity-100"
                        style={{ color: 'var(--fg)', opacity: 0.85 }}
                    >
                        Docs
                    </a>
                    {/* The primary nav CTA is the install command, not the web app.
                        The web app is a destination for people who already paired a
                        machine; a first-time desktop visitor needs the CLI on the
                        machine that runs the code (see funnel: 58% reach pairing,
                        36% reach a session). #get-started scrolls to the stepper
                        whose first action is the copyable install line. */}
                    <a
                        onClick={() => trackCtaClicked({ location: 'hero-nav', label: 'Install Happier' })}
                        href={isHome ? '#get-started' : '/#get-started'}
                        className="hidden items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium transition-transform hover:-translate-y-[1px] md:inline-flex"
                        style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                    >
                        Install Happier
                    </a>
                    <span className="hidden md:inline-flex">
                        <ThemeToggle />
                    </span>
                </div>
            </div>
        </header>
    );
}
