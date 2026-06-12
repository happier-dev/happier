import { HappierMark } from '../components/HappierMark';
import { ThemeToggle } from '../components/ThemeToggle';

/**
 * Top nav. Transparent over the hero.
 *
 * - Mobile (< md): only GitHub + Docs (keeps the header light; "Open the app"
 *   is duplicated as a prominent CTA below the headline, theme toggle is
 *   rarely needed on phones).
 * - md+: GitHub + Docs + "Open the app" + theme toggle.
 */
export function Nav() {
    return (
        <header className="absolute inset-x-0 top-0 z-30">
            <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 pt-5 md:px-3 md:pt-7">
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
                        GitHub
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
                    <a
                        href="https://app.happier.dev/"
                        target="_blank"
                        rel="noreferrer"
                        className="hidden items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium transition-transform hover:-translate-y-[1px] md:inline-flex"
                        style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                    >
                        Open the web app
                    </a>
                    <span className="hidden md:inline-flex">
                        <ThemeToggle />
                    </span>
                </div>
            </div>
        </header>
    );
}
