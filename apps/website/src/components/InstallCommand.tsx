import { useEffect, useMemo, useState } from 'react';

type OsKind = 'mac' | 'linux' | 'windows';

const COMMANDS: Record<OsKind, string> = {
    mac: 'curl -fsSL https://happier.dev/install | bash',
    linux: 'curl -fsSL https://happier.dev/install | bash',
    windows: 'iwr https://happier.dev/install.ps1 -useb | iex',
};

function detectOs(): OsKind {
    if (typeof navigator === 'undefined') return 'mac';
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.platform ?? '').toLowerCase();
    if (ua.includes('win') || platform.includes('win')) return 'windows';
    if (ua.includes('mac') || platform.includes('mac')) return 'mac';
    if (ua.includes('linux') || ua.includes('x11')) return 'linux';
    return 'mac';
}

/**
 * Auto-detects the visitor's OS and renders the matching install command.
 * Static — no manual override. Always-visible border, transparent fill.
 */
export function InstallCommand() {
    const [os, setOs] = useState<OsKind>('mac');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        setOs(detectOs());
    }, []);

    const command = useMemo(() => COMMANDS[os], [os]);

    async function onCopy() {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard denied */
        }
    }

    return (
        <button
            onClick={onCopy}
            className="group inline-flex w-auto max-w-full items-center gap-2.5 rounded-2xl border px-4 py-3 font-mono text-[12.5px] md:text-[13px]"
            style={{
                color: 'var(--fg)',
                background: 'transparent',
                borderColor: 'var(--card-border)',
            }}
            aria-label="Copy install command"
        >
            <span aria-hidden style={{ color: 'var(--muted)' }}>$</span>
            <span className="truncate text-left">{command}</span>
            <span aria-hidden className="ml-1 shrink-0 opacity-60 transition-opacity group-hover:opacity-100">
                {copied ? (
                    <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 10.5l4 4 8-8" />
                    </svg>
                ) : (
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="6" y="6" width="10" height="10" rx="2" />
                        <path d="M4 14V5a1 1 0 0 1 1-1h9" />
                    </svg>
                )}
            </span>
        </button>
    );
}
