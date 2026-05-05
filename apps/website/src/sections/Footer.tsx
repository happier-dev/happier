import { copy } from '@/theme/copy';
import { ThemedLogotype } from '@/components/ThemedLogotype';

export function Footer() {
    return (
        <footer className="border-t border-[color:var(--border-subtle)] px-6 py-14">
            <div className="mx-auto flex max-w-[1180px] flex-col items-start justify-between gap-8 md:flex-row md:items-center">
                <div className="flex items-center gap-3">
                    <ThemedLogotype imageClassName="h-5 w-auto opacity-90" />
                </div>
                <div className="flex flex-col gap-1 text-[13px] text-[color:var(--fg-secondary)] md:items-end">
                    <span>{copy.footer.tagline}</span>
                    <span className="text-[color:var(--fg-tertiary)]">{copy.footer.madeIn}</span>
                </div>
            </div>
        </footer>
    );
}
