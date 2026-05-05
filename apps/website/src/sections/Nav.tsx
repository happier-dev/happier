import { useEffect, useState } from 'react';
import { cn } from '@/utils/cn';
import { copy } from '@/theme/copy';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ThemedLogotype } from '@/components/ThemedLogotype';

export function Nav() {
    const [scrolled, setScrolled] = useState(false);

    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 8);
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    return (
        <nav
            className={cn(
                'fixed inset-x-0 top-0 z-40 transition-[background-color,border-color,backdrop-filter] duration-300',
                scrolled
                    ? 'border-b border-[color:var(--border-subtle)] bg-[color:var(--page-bg)]/80 backdrop-blur-xl'
                    : 'border-b border-transparent bg-transparent',
            )}
        >
            <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between px-4 sm:px-6">
                <a href="#top" aria-label="Happier" className="flex min-w-0 items-center gap-2">
                    <ThemedLogotype imageClassName="h-5 w-auto max-w-[94px] sm:max-w-none" />
                </a>
                <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                    <ThemeToggle />
                    <a
                        href="https://github.com/happier-dev"
                        aria-label="GitHub"
                        className="press inline-flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--border-subtle)] text-[color:var(--fg-primary)] hover:brightness-110 sm:hidden"
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden
                        >
                            <path d="M12 .5C5.65.5.5 5.65.5 12a11.49 11.49 0 0 0 7.85 10.92c.57.1.78-.25.78-.55v-2.07c-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.04 1.77 2.72 1.26 3.39.96.1-.75.4-1.26.74-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.3 1.2-3.1-.12-.3-.52-1.48.11-3.08 0 0 .98-.31 3.2 1.18a11.1 11.1 0 0 1 5.83 0c2.22-1.49 3.2-1.18 3.2-1.18.63 1.6.23 2.78.11 3.08.75.8 1.2 1.84 1.2 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.05.78 2.12v3.14c0 .3.2.65.79.54A11.49 11.49 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
                        </svg>
                    </a>
                    <a
                        href="https://github.com/happier-dev"
                        className="press hidden h-9 items-center gap-1.5 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--border-subtle)] px-3.5 text-[13px] font-medium text-[color:var(--fg-primary)] hover:brightness-110 sm:inline-flex"
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden
                        >
                            <path d="M12 .5C5.65.5.5 5.65.5 12a11.49 11.49 0 0 0 7.85 10.92c.57.1.78-.25.78-.55v-2.07c-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.04 1.77 2.72 1.26 3.39.96.1-.75.4-1.26.74-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.3 1.2-3.1-.12-.3-.52-1.48.11-3.08 0 0 .98-.31 3.2 1.18a11.1 11.1 0 0 1 5.83 0c2.22-1.49 3.2-1.18 3.2-1.18.63 1.6.23 2.78.11 3.08.75.8 1.2 1.84 1.2 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.05.78 2.12v3.14c0 .3.2.65.79.54A11.49 11.49 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
                        </svg>
                        {copy.nav.github}
                    </a>
                    <a
                        href="#get-started"
                        className="press inline-flex h-9 items-center rounded-full bg-[color:var(--fg-primary)] px-3 text-[12px] font-semibold text-[color:var(--page-bg)] hover:brightness-95 sm:px-4 sm:text-[13px]"
                    >
                        Get started
                    </a>
                </div>
            </div>
        </nav>
    );
}
