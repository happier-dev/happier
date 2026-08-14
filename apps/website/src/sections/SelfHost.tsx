import { useState } from 'react';
import { RevealText } from '../components/RevealText';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

/**
 * The three self-host claims, and the one that was false.
 *
 * "Auto-updates, health checks, and monitoring built in. Set it and forget it."
 * is contradicted four times in our own shipped documentation:
 *   deployment/docker.mdx:41    "Docker images do **not** update themselves."
 *   deployment/docker.mdx:72    "It does not install a managed host service."
 *   advanced/updates.mdx:156    "Installers and binary installs do **not**
 *                                auto-update in the background."
 *   hstack/remote-server.mdx:86 "Auto-update is opt-in."
 * /enterprise already had this right (src/data/enterprise.ts). What the managed
 * relay runtime genuinely gives you is a service with a lifecycle —
 * `happier relay host status | start | stop | restart` — and an install command
 * that is also the update command
 * (deployment/self-host-runtime.mdx:36-49, advanced/updates.mdx:185-199).
 * "Set it and forget it" was an unverifiable flourish besides, which the
 * anti-polish rule rules out on its own.
 */
const HIGHLIGHTS = [
    {
        title: 'One-command install',
        description: 'Install the relay server with a single command. Docker or bare metal.',
    },
    {
        title: 'Daily operation',
        description:
            'A managed service you start, stop and check with happier relay host status. Nothing on the host updates itself — you update by rerunning the install command, when you decide to.',
    },
    {
        title: 'Remote access',
        description: 'Access your sessions from anywhere. SSH tunnels, Tailscale, or direct HTTPS.',
    },
] as const;

const INSTALL_CMD = 'happier relay host install';
const STATUS_CMD = 'happier relay host status';

export const SELF_HOST_TERMINAL_LINES = [
    { prompt: true, text: INSTALL_CMD },
    { prompt: false, text: '✓ Server installed' },
    { prompt: false, text: '✓ Web UI configured' },
    { prompt: false, text: '✓ Relay service started' },
    { prompt: false, text: '' },
    { prompt: true, text: STATUS_CMD },
] as const;

/**
 * The three layers a self-hoster owns, top to bottom. Read as a column they are
 * literally the stack the headline refers to, and the repeated "Your" is the
 * whole argument — there is no fourth node, because nothing else is in the path.
 */
export const SELF_HOST_STACK_NODES = [
    {
        id: 'device',
        label: 'Your device',
        detail: 'iOS, Android, desktop, web',
    },
    {
        id: 'relay',
        label: 'Your relay',
        detail: 'Docker or bare metal',
    },
    {
        id: 'machine',
        label: 'Your machine',
        detail: 'Claude Code, Codex, OpenCode',
    },
] as const;

type StackNode = (typeof SELF_HOST_STACK_NODES)[number];

export function SelfHost() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    return (
        <section className="relative" data-section="self-host">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="grid items-center gap-16 md:grid-cols-2 lg:gap-24">
                    <div>
                        <div
                            className="mb-5 inline-flex rounded-full border px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                            style={{ color: 'var(--muted)', borderColor: 'var(--card-border)' }}
                        >{rich(PAGE_PROSE.selfHost.p1)}</div>
                        <RevealText
                            as="h2"
                            text={'Own the stack.\nStay independent.'}
                            className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                            stagger={60}
                        />
                        <p
                            className="mt-6 max-w-[480px] text-[17px] leading-[1.55] md:text-[18px]"
                            style={{ color: 'var(--muted)' }}
                        >{rich(PAGE_PROSE.selfHost.p0)}</p>

                        <div className="mt-10 space-y-6">
                            {HIGHLIGHTS.map((item) => (
                                <div key={item.title}>
                                    <h3
                                        className="text-[16px] font-semibold leading-[1.3]"
                                        style={{ color: 'var(--fg)' }}
                                    >
                                        {item.title}
                                    </h3>
                                    <p
                                        className="mt-1 text-[14px] leading-[1.55]"
                                        style={{ color: 'var(--muted)' }}
                                    >
                                        {item.description}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col gap-5">
                        <OwnedStack />
                        <TerminalBlock lines={SELF_HOST_TERMINAL_LINES} />
                    </div>
                </div>
            </div>
        </section>
    );
}

/**
 * The stack, drawn: device → relay → machine, with live traffic on the links.
 * No frames of any kind — the three bare glyphs and the repeated "Your" are the
 * whole argument, and a box around them would only compete with the terminal
 * block underneath.
 */
function OwnedStack() {
    return (
        <div className="stackrow">
            {SELF_HOST_STACK_NODES.map((node) => (
                <div key={node.id} className="text-center">
                    <span className="stackrow__icon" style={{ color: 'var(--fg)' }}>
                        <StackIcon id={node.id} />
                    </span>
                    {/* 15px wraps "Your machine" at phone column widths while the other
                        two labels hold one line, which staggers the subtitles. */}
                    <span
                        className="mt-3.5 block text-[13px] font-semibold leading-tight sm:text-[15px]"
                        style={{ color: 'var(--fg)' }}
                    >
                        {node.label}
                    </span>
                    <span
                        className="stackrow__detail mt-1 block text-[12.5px] leading-[1.45]"
                        style={{ color: 'var(--muted)' }}
                    >
                        {node.detail}
                    </span>
                </div>
            ))}

            {/* Rails are siblings of the cells, not gutter items, so they can be
                anchored to the icon centres rather than to whatever space is left. */}
            <FlowRail className="stackflow--1" />
            <FlowRail className="stackflow--2" />
        </div>
    );
}

/** Two dots out, one back — enough to read as traffic without becoming a barber pole. */
function FlowRail({ className }: { className: string }) {
    return (
        <div className={`stackflow ${className}`} aria-hidden>
            <span className="stackflow__dot" />
            <span className="stackflow__dot" style={{ animationDelay: '1.3s' }} />
            <span className="stackflow__dot stackflow__dot--back" style={{ animationDelay: '0.65s' }} />
        </div>
    );
}

function StackIcon({ id }: { id: StackNode['id'] }) {
    // Stroke thins as the glyph grows so the rendered line stays ~1.9px at 36px
    // — a 1.6 stroke scaled 1.5x would read as a much heavier icon set.
    const props = {
        width: 36,
        height: 36,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
    };

    if (id === 'device') {
        return (
            <svg {...props}>
                <rect x="7" y="2.5" width="10" height="19" rx="2.6" />
                <path d="M10.9 5.5h2.2" />
            </svg>
        );
    }

    if (id === 'relay') {
        return (
            <svg {...props}>
                <rect x="3" y="4" width="18" height="6.5" rx="2" />
                <rect x="3" y="13.5" width="18" height="6.5" rx="2" />
                <path d="M6.7 7.25h.01M6.7 16.75h.01" />
            </svg>
        );
    }

    return (
        <svg {...props}>
            <rect x="2.5" y="4" width="19" height="13" rx="2.4" />
            <path d="m6.8 8.7 2.5 1.8-2.5 1.8M12 12.9h4.6" />
            <path d="M9 20.5h6" />
        </svg>
    );
}

function TerminalBlock({
    lines,
}: {
    lines: ReadonlyArray<{ prompt: boolean; text: string }>;
}) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const [copied, setCopied] = useState(false);
    const commands = lines.filter((l) => l.prompt).map((l) => l.text).join('\n');

    async function onCopy() {
        try {
            await navigator.clipboard.writeText(commands);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard denied */
        }
    }

    return (
        <div
            className="relative overflow-hidden rounded-2xl border font-mono text-[13px] leading-[1.7]"
            style={{ borderColor: 'var(--card-border)' }}
        >
            <div
                className="flex items-center justify-between border-b px-4 py-2.5"
                style={{ borderColor: 'var(--card-border)' }}
            >
                <div className="flex gap-1.5">
                    <span className="h-3 w-3 rounded-full" style={{ background: 'var(--card-border)' }} />
                    <span className="h-3 w-3 rounded-full" style={{ background: 'var(--card-border)' }} />
                    <span className="h-3 w-3 rounded-full" style={{ background: 'var(--card-border)' }} />
                </div>
                <button
                    onClick={onCopy}
                    className="text-[12px] opacity-60 transition-opacity hover:opacity-100"
                    style={{ color: 'var(--fg)' }}
                    aria-label={PAGE_PROSE.selfHost.p2}
                >
                    {copied ? 'Copied!' : 'Copy'}
                </button>
            </div>
            <div className="px-4 py-4">
                {lines.map((line, i) => (
                    <div key={i}>
                        {line.prompt ? (
                            <span>
                                <span style={{ color: 'var(--muted)' }}>$ </span>
                                <span style={{ color: 'var(--fg)' }}>{line.text}</span>
                            </span>
                        ) : (
                            <span style={{ color: 'var(--muted)' }}>{line.text}</span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
