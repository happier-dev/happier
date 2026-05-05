import { useState } from 'react';
import { copy } from '@/theme/copy';

const inactiveStoreBadges = [
    {
        alt: 'Download on the App Store',
        src: '/images/badges/app-store.svg',
    },
    {
        alt: 'Get it on Google Play',
        src: '/images/badges/google-play.svg',
    },
] as const;

export function GetStarted() {
    const [copied, setCopied] = useState(false);

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(copy.getStarted.install);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // ignore
        }
    };

    return (
        <section id="get-started" className="relative px-6 py-28 sm:py-36">
            <div className="mx-auto max-w-[720px] text-center">
                <span className="chip">{copy.getStarted.kicker}</span>
                <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.02em] text-[color:var(--fg-primary)] sm:text-[56px]">
                    {copy.getStarted.headline}
                </h2>

                <div className="mx-auto mt-8 flex w-full max-w-[540px] items-center gap-2 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-card)] px-5 py-3 text-left font-mono text-[13.5px] text-[color:var(--fg-primary)] shadow-device-active">
                    <span className="select-none text-[color:var(--fg-tertiary)]">$</span>
                    <span className="flex-1 truncate">{copy.getStarted.install}</span>
                    <button
                        type="button"
                        onClick={onCopy}
                        className="press rounded-full bg-[color:var(--fg-primary)] px-3 py-1 text-[12px] font-semibold text-[color:var(--page-bg)] hover:brightness-95"
                    >
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </div>
                <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                    {copied ? 'Install command copied to clipboard.' : ''}
                </span>

                <div
                    className="mt-6 flex items-center justify-center gap-3"
                    data-store-badge-state="inactive"
                    aria-label="Mobile store badges unavailable"
                >
                    {inactiveStoreBadges.map(badge => (
                        <span
                            key={badge.src}
                            aria-hidden="true"
                            className="inline-flex items-center cursor-default select-none grayscale opacity-70 pointer-events-none"
                        >
                            <img
                                src={badge.src}
                                alt={badge.alt}
                                draggable={false}
                                className="h-10 img-outline rounded-token-md"
                            />
                        </span>
                    ))}
                </div>
            </div>
        </section>
    );
}
