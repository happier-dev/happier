import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from './ThemeContext';

/**
 * Download badges row.
 *
 * App Store + Android render as simple links. The Desktop badge is a
 * split button:
 *   • Click the main area → direct-download the smart-detected variant
 *     (or open the popover if arch detection is uncertain — e.g. Safari
 *     on Mac, where Apple freezes the UA).
 *   • Click the chevron → always opens the popover with all four desktop
 *     variants (macOS Apple Silicon / Intel, Windows, Linux). The
 *     detected one is highlighted with a "Detected" chip.
 *
 * Every URL comes from data/downloads.ts. It used to build them here from
 * version-less filenames on the rolling `ui-desktop-stable` tag, on the
 * assumption that the tag published version-less assets. It does not — every
 * asset under that tag carries `-v0.2.0` — so all four desktop downloads were
 * 404 in production, and the Google Play badge pointed at a listing
 * (`id=dev.happier`) that has never existed.
 */

import {
    ANDROID_APK_URL,
    APP_STORE_URL,
    DESKTOP_PLATFORMS,
    DESKTOP_RELEASES_PAGE,
    type DesktopPlatformId,
} from '../data/downloads';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

type Os = 'mac' | 'win' | 'linux' | 'unknown';
type Arch = 'arm64' | 'x86_64' | 'unknown';

const DESKTOP_LABEL: Record<Os, string> = {
    mac: 'macOS',
    win: 'Windows',
    linux: 'Linux',
    unknown: 'Desktop',
};

const PLATFORM_OPTIONS = DESKTOP_PLATFORMS;

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
    if (os === 'unknown') return DESKTOP_RELEASES_PAGE;
    const resolvedArch = arch !== 'unknown' ? arch : os === 'mac' ? 'arm64' : 'x86_64';
    const key = `${os}-${resolvedArch}` as DesktopPlatformId;
    const platform = PLATFORM_OPTIONS.find((p) => p.id === key);
    return platform ? platform.href : DESKTOP_RELEASES_PAGE;
}

type BadgeSpec = {
    href: string;
    eyebrow: string;
    label: string;
    icon: ReactNode;
};

const AppleIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-7 w-7">
        <path d="M17.0473 12.7227C17.0763 15.8597 19.8 16.9047 19.83 16.917C19.807 16.9897 19.402 18.405 18.387 19.866C17.508 21.131 16.598 22.391 15.165 22.416C13.756 22.441 13.302 21.586 11.692 21.586C10.082 21.586 9.578 22.391 8.244 22.441C6.86 22.491 5.808 21.067 4.92 19.807C3.106 17.228 1.72 12.515 3.582 9.337C4.506 7.755 6.161 6.752 7.957 6.727C9.317 6.702 10.601 7.62 11.432 7.62C12.262 7.62 13.821 6.517 15.461 6.682C16.149 6.71 18.078 6.961 19.317 8.79C19.217 8.852 17.022 10.118 17.047 12.7227M14.39 4.95C15.123 4.064 15.617 2.83 15.482 1.6C14.434 1.642 13.166 2.297 12.408 3.182C11.728 3.967 11.134 5.221 11.293 6.427C12.46 6.518 13.656 5.836 14.39 4.95" />
    </svg>
);

/**
 * Android is a direct APK download, not a store badge.
 *
 * There is no Google Play listing to link to: `dev.happier` 404s and has never
 * existed, and `dev.happier.app` is a closed testing track that 404s for
 * everyone who is not already an opted-in tester. Shipping a Play badge that
 * dead-ends is worse than shipping no badge — so this reads "Android APK ·
 * Direct download", which is exactly what it is, and what the 2,056 people who
 * have already downloaded it did.
 */
const AndroidIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-7 w-7">
        <path d="M6.8 8.2h10.4a.6.6 0 0 1 .6.6v7.4a1.4 1.4 0 0 1-1.4 1.4H7.6a1.4 1.4 0 0 1-1.4-1.4V8.8a.6.6 0 0 1 .6-.6Z" />
        <rect x="3" y="8.6" width="2.3" height="6.6" rx="1.15" />
        <rect x="18.7" y="8.6" width="2.3" height="6.6" rx="1.15" />
        <rect x="8" y="17.8" width="2.3" height="4.4" rx="1.15" />
        <rect x="13.7" y="17.8" width="2.3" height="4.4" rx="1.15" />
        <path
            d="M8.4 7.1a4.2 4.2 0 0 1 7.2 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
        />
        <circle cx="9.6" cy="5.4" r="0.62" />
        <circle cx="14.4" cy="5.4" r="0.62" />
        <path d="M8.5 3 7.8 1.9M15.5 3l.7-1.1" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
);

const DesktopIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-7 w-7">
        <rect x="2.5" y="4" width="19" height="13" rx="2" />
        <path d="M9 21h6" />
        <path d="M12 17v4" />
    </svg>
);

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="h-3.5 w-3.5 transition-transform duration-200"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
            <path d="M4 6l4 4 4-4" />
        </svg>
    );
}

// borderColor / background / color all reference @property-animated tokens
// (--card-border, --card, --fg). No explicit transition needed — adding one
// would cause a "transition chasing transition" lag where the badge's color
// trails the rest of the page on theme switch.
const BADGE_STYLE = {
    borderColor: 'var(--card-border)',
    background: 'var(--card)',
    color: 'var(--fg)',
} as const;

export function DownloadBadges({ webApp = false }: { webApp?: boolean } = {}) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { theme } = useTheme();
    const isDark = theme === 'dark';

    const [os, setOs] = useState<Os>('unknown');
    const [arch, setArch] = useState<Arch>('unknown');
    const [archDetected, setArchDetected] = useState(false);
    const [popoverOpen, setPopoverOpen] = useState(false);
    const desktopWrapperRef = useRef<HTMLDivElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [popoverPos, setPopoverPos] = useState<{ left: number; top: number } | null>(null);

    useEffect(() => {
        setOs(detectOs());

        const syncArch = detectArchFromUserAgent();
        if (syncArch !== 'unknown') {
            setArch(syncArch);
            setArchDetected(true);
        }

        type UAData = { getHighEntropyValues?: (keys: string[]) => Promise<{ architecture?: string }> };
        const uaData = (navigator as unknown as { userAgentData?: UAData }).userAgentData;
        if (uaData?.getHighEntropyValues) {
            uaData
                .getHighEntropyValues(['architecture'])
                .then((data) => {
                    if (data?.architecture === 'arm') {
                        setArch('arm64');
                        setArchDetected(true);
                    } else if (data?.architecture === 'x86') {
                        setArch('x86_64');
                        setArchDetected(true);
                    }
                })
                .catch(() => {
                    /* not supported */
                });
        }
    }, []);

    // Click-outside to dismiss the popover. The popover is portaled to
    // document.body, so we check both the anchor and the popover itself.
    useEffect(() => {
        if (!popoverOpen) return;
        function handleClickOutside(event: MouseEvent) {
            const target = event.target as Node;
            const insideAnchor = desktopWrapperRef.current?.contains(target);
            const insidePopover = popoverRef.current?.contains(target);
            if (!insideAnchor && !insidePopover) {
                setPopoverOpen(false);
            }
        }
        function handleEscape(event: KeyboardEvent) {
            if (event.key === 'Escape') setPopoverOpen(false);
        }
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [popoverOpen]);

    // Track the anchor button's viewport position so the portaled popover
    // stays glued to it on scroll/resize.
    useLayoutEffect(() => {
        if (!popoverOpen) {
            setPopoverPos(null);
            return;
        }
        function updatePos() {
            const anchor = desktopWrapperRef.current;
            if (!anchor) return;
            const rect = anchor.getBoundingClientRect();
            setPopoverPos({ left: rect.left, top: rect.bottom + 8 });
        }
        updatePos();
        window.addEventListener('scroll', updatePos, true);
        window.addEventListener('resize', updatePos);
        return () => {
            window.removeEventListener('scroll', updatePos, true);
            window.removeEventListener('resize', updatePos);
        };
    }, [popoverOpen]);

    const resolvedArch: Arch = arch !== 'unknown' ? arch : os === 'mac' ? 'arm64' : 'x86_64';
    const detectedHref = buildDesktopHref(os, resolvedArch);
    const detectedId = `${os}-${resolvedArch}`;
    const canDetectPrecisely = os !== 'unknown' && archDetected;

    function handleMainClick(event: React.MouseEvent<HTMLAnchorElement>) {
        if (!canDetectPrecisely) {
            event.preventDefault();
            setPopoverOpen(true);
        }
    }

    const storeBadges: ReadonlyArray<BadgeSpec> = [
        {
            href: APP_STORE_URL,
            eyebrow: 'Download on',
            label: 'App Store',
            icon: AppleIcon,
        },
        {
            href: ANDROID_APK_URL,
            eyebrow: 'Direct download',
            label: 'Android APK',
            icon: AndroidIcon,
        },
    ];

    return (
        <div className="flex flex-wrap items-center gap-2.5">
            {storeBadges.map((badge) => (
                <a
                    key={badge.label + badge.eyebrow}
                    href={badge.href}
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-2.5 rounded-2xl border px-3.5 py-2 transition-transform hover:-translate-y-[1px]"
                    style={BADGE_STYLE}
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
                        <span className="text-[14px] font-semibold tracking-tight">{badge.label}</span>
                    </span>
                </a>
            ))}

            {/* Desktop split button + popover */}
            <div ref={desktopWrapperRef} className="relative">
                <div
                    className="inline-flex items-stretch overflow-hidden rounded-2xl border"
                    style={BADGE_STYLE}
                >
                    <a
                        href={detectedHref}
                        target="_blank"
                        rel="noreferrer"
                        onClick={handleMainClick}
                        className="group flex items-center gap-2.5 px-3.5 py-2 transition-transform hover:-translate-y-[1px]"
                        style={{ color: 'var(--fg)' }}
                        aria-label={canDetectPrecisely ? `Download for ${DESKTOP_LABEL[os]}` : 'Show desktop download options'}
                    >
                        <span className="shrink-0" aria-hidden>
                            {DesktopIcon}
                        </span>
                        <span className="flex flex-col leading-[1.1]">
                            <span
                                className="text-[9.5px] font-medium uppercase tracking-[0.12em]"
                                style={{ color: 'var(--muted)' }}
                            >{rich(PAGE_PROSE.downloadBadges.p0)}</span>
                            <span className="text-[14px] font-semibold tracking-tight">
                                {DESKTOP_LABEL[os]}
                            </span>
                        </span>
                    </a>

                    <div
                        className="my-2 w-px self-stretch"
                        style={{ background: 'var(--card-border)' }}
                        aria-hidden
                    />

                    <button
                        onClick={() => setPopoverOpen((prev) => !prev)}
                        className="grid place-items-center px-2.5 transition-opacity hover:opacity-80"
                        style={{ color: 'var(--fg)' }}
                        aria-label={PAGE_PROSE.downloadBadges.p1}
                        aria-expanded={popoverOpen}
                        aria-haspopup="menu"
                    >
                        <ChevronIcon open={popoverOpen} />
                    </button>
                </div>

                {popoverOpen && popoverPos && createPortal(
                    <div
                        ref={popoverRef}
                        role="menu"
                        className="min-w-[260px] rounded-2xl border p-1.5"
                        style={{
                            position: 'fixed',
                            left: popoverPos.left,
                            top: popoverPos.top,
                            zIndex: 100,
                            background: isDark ? 'rgba(15,15,18,0.92)' : 'rgba(252,250,245,0.96)',
                            borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(10,10,11,0.08)',
                            backdropFilter: 'blur(24px)',
                            WebkitBackdropFilter: 'blur(24px)',
                            boxShadow: isDark
                                ? '0 24px 60px -10px rgba(0,0,0,0.6)'
                                : '0 24px 60px -10px rgba(10,10,11,0.18)',
                            transition: 'background-color 700ms ease, border-color 700ms ease, box-shadow 700ms ease',
                        }}
                    >
                        {PLATFORM_OPTIONS.map((p) => {
                            const isDetected = canDetectPrecisely && p.id === detectedId;
                            return (
                                <a
                                    key={p.id}
                                    href={p.href}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={() => setPopoverOpen(false)}
                                    role="menuitem"
                                    className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
                                    style={
                                        isDetected
                                            ? {
                                                  background: isDark
                                                      ? 'rgba(255,255,255,0.06)'
                                                      : 'rgba(10,10,11,0.05)',
                                              }
                                            : undefined
                                    }
                                >
                                    <span className="flex items-center gap-2">
                                        <span
                                            className="text-[14px] font-medium tracking-tight"
                                            style={{ color: 'var(--fg)' }}
                                        >
                                            {p.label}
                                        </span>
                                        {isDetected && (
                                            <span
                                                className="rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.12em]"
                                                style={{
                                                    color: 'var(--bg)',
                                                    background: 'var(--fg)',
                                                }}
                                            >{rich(PAGE_PROSE.downloadBadges.p2)}</span>
                                        )}
                                    </span>
                                    <span
                                        className="text-[11.5px] font-medium"
                                        style={{ color: 'var(--muted)' }}
                                    >
                                        {p.sublabel}
                                    </span>
                                </a>
                            );
                        })}
                    </div>,
                    document.body,
                )}
            </div>

            {/* Primary "open the web app" CTA shares the same wrap row so on
                mobile it pairs next to the desktop badge (shorter labels make
                the four buttons fit two-per-row). */}
            {webApp && (
                <a
                    href="https://app.happier.dev/"
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-2 self-stretch rounded-2xl px-5 text-[14px] font-semibold transition-transform hover:-translate-y-[1px]"
                    style={{
                        background: 'var(--fg)',
                        color: 'var(--bg)',
                        boxShadow: isDark
                            ? '0 20px 60px -20px rgba(255, 255, 255, 0.22)'
                            : '0 20px 60px -20px rgba(10, 10, 11, 0.35)',
                        transition: 'box-shadow 700ms ease',
                    }}
                    aria-label={PAGE_PROSE.downloadBadges.p3}
                >
                    <span>{rich(PAGE_PROSE.downloadBadges.p4)}</span>
                    <svg viewBox="0 0 16 16" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 8h10" />
                        <path d="M9 4l4 4-4 4" />
                    </svg>
                </a>
            )}
        </div>
    );
}
