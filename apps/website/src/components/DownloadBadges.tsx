import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Download badges row.
 *
 * Three pill-shaped CTAs styled like the well-known store badges
 * ("Download on the App Store" / "GET IT ON Google Play") plus a desktop
 * companion. Rendered as glass pills so they sit cleanly on the planet
 * background without fighting it.
 *
 * Desktop binaries live on GitHub under the rolling tag
 * `ui-desktop-stable` with stable, version-less filenames (the pipeline
 * strips the version suffix), so URLs of the form
 *   .../releases/download/ui-desktop-stable/happier-ui-desktop-<platform>-<arch>.<ext>
 * keep working across releases.
 *
 * We detect the visitor's OS synchronously (UA string is enough) and
 * refine the architecture asynchronously via `navigator.userAgentData`
 * (Chromium only — Safari/Firefox freeze the UA, so we default to
 * Apple Silicon on Mac since >85% of active Macs are now ARM). A small
 * "Other downloads" link sits below the row for anyone who needs a
 * different variant.
 */

type Os = 'mac' | 'win' | 'linux' | 'unknown';
type Arch = 'arm64' | 'x86_64' | 'unknown';

const ASSET_BASE = 'https://github.com/happier-dev/happier/releases/download/ui-desktop-stable';
const RELEASES_PAGE = 'https://github.com/happier-dev/happier/releases/tag/ui-desktop-stable';

// Filename suffixes after `happier-ui-desktop-`.
const ASSET_FILE: Record<string, string> = {
    'mac-arm64': 'happier-ui-desktop-darwin-aarch64.dmg',
    'mac-x86_64': 'happier-ui-desktop-darwin-x86_64.dmg',
    'win-arm64': 'happier-ui-desktop-windows-x86_64.exe', // no ARM build yet — fall back to x64
    'win-x86_64': 'happier-ui-desktop-windows-x86_64.exe',
    'linux-arm64': 'happier-ui-desktop-linux-x86_64.AppImage', // no ARM build yet — fall back to x64
    'linux-x86_64': 'happier-ui-desktop-linux-x86_64.AppImage',
};

const DESKTOP_LABEL: Record<Os, string> = {
    mac: 'macOS',
    win: 'Windows',
    linux: 'Linux',
    unknown: 'Desktop',
};

function detectOs(): Os {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.platform ?? '').toLowerCase();
    if (ua.includes('mac') || platform.includes('mac')) return 'mac';
    if (ua.includes('win') || platform.includes('win')) return 'win';
    if (ua.includes('linux') || ua.includes('x11')) return 'linux';
    return 'unknown';
}

function detectArchFromUserAgent(): Arch {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('aarch64') || ua.includes('arm64')) return 'arm64';
    if (ua.includes('x86_64') || ua.includes('wow64') || ua.includes('win64') || ua.includes('x64')) return 'x86_64';
    return 'unknown';
}

function buildDesktopHref(os: Os, arch: Arch): string {
    if (os === 'unknown') return RELEASES_PAGE;
    // For Mac with unknown arch, default to Apple Silicon (the modern default,
    // and Safari/Firefox refuse to disclose the arch).
    const resolvedArch =
        arch !== 'unknown'
            ? arch
            : os === 'mac'
              ? 'arm64'
              : 'x86_64';
    const key = `${os}-${resolvedArch}`;
    const file = ASSET_FILE[key];
    if (!file) return RELEASES_PAGE;
    return `${ASSET_BASE}/${file}`;
}

type BadgeSpec = {
    href: string;
    eyebrow: string;
    label: string;
    icon: ReactNode;
    external?: boolean;
};

const AppleIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-7 w-7">
        <path d="M17.0473 12.7227C17.0763 15.8597 19.8 16.9047 19.83 16.917C19.807 16.9897 19.402 18.405 18.387 19.866C17.508 21.131 16.598 22.391 15.165 22.416C13.756 22.441 13.302 21.586 11.692 21.586C10.082 21.586 9.578 22.391 8.244 22.441C6.86 22.491 5.808 21.067 4.92 19.807C3.106 17.228 1.72 12.515 3.582 9.337C4.506 7.755 6.161 6.752 7.957 6.727C9.317 6.702 10.601 7.62 11.432 7.62C12.262 7.62 13.821 6.517 15.461 6.682C16.149 6.71 18.078 6.961 19.317 8.79C19.217 8.852 17.022 10.118 17.047 12.7227M14.39 4.95C15.123 4.064 15.617 2.83 15.482 1.6C14.434 1.642 13.166 2.297 12.408 3.182C11.728 3.967 11.134 5.221 11.293 6.427C12.46 6.518 13.656 5.836 14.39 4.95" />
    </svg>
);

const PlayIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-7 w-7">
        <path d="M3 2.6c-.3.2-.5.5-.5 1V20.4c0 .4.2.8.5 1l10.1-9.4L3 2.6Z" />
        <path d="m13.1 12 3.1-2.9-3.1-2.9 3.7 2.1c1.1.7 1.1 2.7 0 3.4l-3.7 2.3Z" opacity="0.7" />
        <path d="M3.3 21.4 13.1 12l3.1 2.9-9.3 5.4c-1 .6-2.3.1-3-.7l-.6-.2Z" opacity="0.85" />
        <path d="M3.3 2.6 13.1 12l3.1-2.9-9.3-5.4c-1-.6-2.3-.1-3 .7l-.6.2Z" opacity="0.9" />
    </svg>
);

const DesktopIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-7 w-7">
        <rect x="2.5" y="4" width="19" height="13" rx="2" />
        <path d="M9 21h6" />
        <path d="M12 17v4" />
    </svg>
);

export function DownloadBadges() {
    const [os, setOs] = useState<Os>('unknown');
    const [arch, setArch] = useState<Arch>('unknown');

    useEffect(() => {
        setOs(detectOs());
        setArch(detectArchFromUserAgent());

        // Refine arch async via Chromium's userAgentData (the only reliable
        // way to tell Apple Silicon from Intel in a privacy-conscious browser).
        const uaData = (navigator as unknown as { userAgentData?: { getHighEntropyValues?: (k: string[]) => Promise<{ architecture?: string }> } }).userAgentData;
        if (uaData?.getHighEntropyValues) {
            uaData
                .getHighEntropyValues(['architecture'])
                .then((data) => {
                    if (data?.architecture === 'arm') setArch('arm64');
                    else if (data?.architecture === 'x86') setArch('x86_64');
                })
                .catch(() => {
                    /* not supported */
                });
        }
    }, []);

    const desktopHref = buildDesktopHref(os, arch);

    const badges: ReadonlyArray<BadgeSpec> = [
        {
            href: 'https://apps.apple.com/app/happier-claude-codex-opencode/id6758554297',
            eyebrow: 'Download on the',
            label: 'App Store',
            icon: AppleIcon,
            external: true,
        },
        {
            href: 'https://play.google.com/store/apps/details?id=dev.happier',
            eyebrow: 'Get it on',
            label: 'Google Play',
            icon: PlayIcon,
            external: true,
        },
        {
            href: desktopHref,
            eyebrow: 'Download for',
            label: DESKTOP_LABEL[os],
            icon: DesktopIcon,
            external: true,
        },
    ];

    return (
        <div className="mt-4 flex flex-col items-start gap-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
                {badges.map((badge) => (
                    <a
                        key={badge.label + badge.eyebrow}
                        href={badge.href}
                        target={badge.external ? '_blank' : undefined}
                        rel={badge.external ? 'noreferrer' : undefined}
                        className="group inline-flex items-center gap-2.5 rounded-2xl border px-3.5 py-2 transition-transform hover:-translate-y-[1px]"
                        style={{
                            borderColor: 'var(--card-border)',
                            background: 'var(--card)',
                            color: 'var(--fg)',
                        }}
                    >
                        <span className="shrink-0" aria-hidden>
                            {badge.icon}
                        </span>
                        <span className="flex flex-col leading-[1.1]">
                            <span
                                className="text-[9.5px] font-medium uppercase tracking-[0.12em]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {badge.eyebrow}
                            </span>
                            <span className="text-[14px] font-semibold tracking-tight">
                                {badge.label}
                            </span>
                        </span>
                    </a>
                ))}
            </div>
            <a
                href={RELEASES_PAGE}
                target="_blank"
                rel="noreferrer"
                className="ml-0.5 text-[11.5px] font-medium transition-opacity hover:opacity-100"
                style={{ color: 'var(--muted)' }}
            >
                Other downloads & older versions →
            </a>
        </div>
    );
}
