import { HappierMark } from '../components/HappierMark';

export const FOOTER_COLUMNS = [
    {
        title: 'Product',
        links: [
            { label: 'Features', href: '#features' },
            { label: 'Get started', href: '#get-started' },
            { label: 'Web app', href: 'https://app.happier.dev/', external: true },
            { label: 'Docs', href: 'https://docs.happier.dev/', external: true },
        ],
    },
    {
        title: 'Open source',
        links: [
            { label: 'GitHub', href: 'https://github.com/happier-dev/happier', external: true },
            { label: 'Self-host', href: 'https://docs.happier.dev/deployment/self-host-runtime', external: true },
            { label: 'License', href: 'https://github.com/happier-dev/happier/blob/main/LICENSE', external: true },
        ],
    },
    {
        title: 'Resources',
        links: [
            { label: 'Changelog', href: 'https://docs.happier.dev/changelog', external: true },
            { label: 'Discord', href: 'https://discord.gg/happier', external: true },
        ],
    },
] as const;

export function Footer() {
    return (
        <footer className="relative border-t" style={{ borderColor: 'var(--card-border)' }}>
            <div className="mx-auto max-w-[1400px] px-6 py-16 md:px-10 md:py-20">
                <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
                    <div>
                        <HappierMark />
                        <p
                            className="mt-5 max-w-[320px] text-[14px] leading-[1.6]"
                            style={{ color: 'var(--muted)' }}
                        >
                            The control room for your AI coding agents — on every device, with your own
                            subscriptions, end-to-end encrypted.
                        </p>
                    </div>

                    {FOOTER_COLUMNS.map((col) => (
                        <div key={col.title}>
                            <div
                                className="mb-4 text-[12px] font-semibold uppercase tracking-[0.16em]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {col.title}
                            </div>
                            <ul className="space-y-2.5">
                                {col.links.map((link) => (
                                    <li key={link.label}>
                                        <a
                                            href={link.href}
                                            {...('external' in link && link.external
                                                ? { target: '_blank', rel: 'noreferrer' }
                                                : {})}
                                            className="text-[14px] transition-opacity hover:opacity-100"
                                            style={{ color: 'var(--fg)', opacity: 0.7 }}
                                        >
                                            {link.label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                <div
                    className="mt-14 flex flex-col items-start justify-between gap-4 border-t pt-8 text-[13px] sm:flex-row sm:items-center"
                    style={{ borderColor: 'var(--card-border)', color: 'var(--muted)' }}
                >
                    <span>© {new Date().getFullYear()} Happier. Open source. Made with care.</span>
                    <span className="font-mono text-[12px]">happier.dev</span>
                </div>
            </div>
        </footer>
    );
}
