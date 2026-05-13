import { HappierMark } from '../components/HappierMark';

const COLUMNS = [
    {
        title: 'Product',
        links: [
            { label: 'Features', href: '#features' },
            { label: 'Sessions', href: '#sessions' },
            { label: 'Changelog', href: '#changelog' },
            { label: 'Roadmap', href: '#roadmap' },
        ],
    },
    {
        title: 'Open source',
        links: [
            { label: 'GitHub', href: 'https://github.com/slopus/happier' },
            { label: 'Self-host', href: '#self-host' },
            { label: 'Privacy', href: '#privacy' },
            { label: 'License', href: '#license' },
        ],
    },
    {
        title: 'Resources',
        links: [
            { label: 'Docs', href: '#docs' },
            { label: 'Examples', href: '#examples' },
            { label: 'Community', href: '#community' },
            { label: 'Contact', href: '#contact' },
        ],
    },
];

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

                    {COLUMNS.map((col) => (
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
                                            className="text-[14px] transition-colors hover:opacity-100"
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
