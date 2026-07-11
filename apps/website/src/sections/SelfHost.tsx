import { useState } from 'react';
import { RevealText } from '../components/RevealText';

const HIGHLIGHTS = [
    {
        title: 'One-command install',
        description: 'Install the relay server with a single command. Docker or bare metal.',
    },
    {
        title: 'Daily operation',
        description: 'Auto-updates, health checks, and monitoring built in. Set it and forget it.',
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

export const SELF_HOST_SERVICES = [
    { name: 'Relay server', status: 'running' },
    { name: 'Web UI', status: 'running' },
    { name: 'Managed service', status: 'running' },
] as const;

export function SelfHost() {
    return (
        <section className="relative">
            <div className="mx-auto max-w-[1400px] px-6 py-32 md:px-10 md:py-44">
                <div className="grid items-center gap-16 md:grid-cols-2 lg:gap-24">
                    <div>
                        <div
                            className="mb-5 inline-flex rounded-full border px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                            style={{ color: 'var(--muted)', borderColor: 'var(--card-border)' }}
                        >
                            Self-host
                        </div>
                        <RevealText
                            as="h2"
                            text={'Own the stack.\nStay independent.'}
                            className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                            stagger={60}
                        />
                        <p
                            className="mt-6 max-w-[480px] text-[17px] leading-[1.55] md:text-[18px]"
                            style={{ color: 'var(--muted)' }}
                        >
                            Run the Happier relay server on your own infrastructure.
                            Your data never leaves your network.
                        </p>

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
                        <TerminalBlock
                            lines={SELF_HOST_TERMINAL_LINES}
                        />

                        <div
                            className="rounded-2xl border p-5"
                            style={{ borderColor: 'var(--card-border)' }}
                        >
                            <div className="space-y-3">
                                {SELF_HOST_SERVICES.map((svc) => (
                                    <div
                                        key={svc.name}
                                        className="flex items-center justify-between text-[14px]"
                                    >
                                        <span style={{ color: 'var(--fg)' }}>{svc.name}</span>
                                        <span className="inline-flex items-center gap-1.5 text-emerald-400">
                                            <span className="h-2 w-2 rounded-full bg-emerald-400" />
                                            {svc.status}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

function TerminalBlock({
    lines,
}: {
    lines: ReadonlyArray<{ prompt: boolean; text: string }>;
}) {
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
                    aria-label="Copy commands"
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
