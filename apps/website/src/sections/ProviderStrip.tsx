import { copy } from '@/theme/copy';

/**
 * Horizontal strip of provider "commands" — reinforces the multi-provider
 * message from the hero demo. Copy is the actual CLI command for each.
 * Monospace, grayscale until hover — classic dev-tool brand move.
 */
export function ProviderStrip() {
    return (
        <section
            id="providers"
            className="relative border-y border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] py-10"
        >
            <div className="mx-auto max-w-[1180px] px-6">
                <p className="mb-6 text-center text-[11px] font-medium uppercase tracking-[0.2em] text-[color:var(--fg-tertiary)]">
                    {copy.providers.title}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
                    {copy.providers.list.map(p => (
                        <code
                            key={p.name}
                            className="font-mono text-[13px] text-[color:var(--fg-secondary)] transition-colors duration-200 hover:text-[color:var(--fg-primary)]"
                        >
                            <span className="text-[color:var(--fg-tertiary)]">$</span> {p.command}
                        </code>
                    ))}
                </div>
            </div>
        </section>
    );
}
