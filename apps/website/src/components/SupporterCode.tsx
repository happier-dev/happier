import { useEffect, useState } from 'react';

import { useSiteData } from '../i18n/siteData';

/**
 * The supporter code a website checkout carries to Polar as `reference_id`
 * (plan 03 F6/F7). The Supporter CTA mints it and keeps it in local storage;
 * /thanks, Polar's success URL, reads it back and hands it to the app.
 *
 * The key and the app link are the contract with plan 04's Supporter sheet:
 * `happier://settings/plan?supporterCode=<code>` opens Plans & Supporter with
 * the code prefilled; a press in the app applies it. The code never goes into
 * an https URL or query; this custom-scheme link is the one sanctioned
 * exception (plan 03 F6), because it never reaches a server log.
 */
export const SUPPORTER_CODE_STORAGE_KEY = 'happier.supporterCode';

export function supporterAppLink(code: string): string {
    return `happier://settings/plan?supporterCode=${encodeURIComponent(code)}`;
}

/**
 * `SupporterCodeV1Schema` (packages/protocol/src/plans/supporterV1.ts): 128
 * random bits as 32 lowercase hex characters. Mirrored rather than imported
 * because the 0.2 site carries no workspace package (importing would add a
 * protocol build to the website promote and zod to this page);
 * SupporterCode.test.tsx checks it against the protocol schema so drift fails
 * the suite instead of the app silently rejecting the code.
 */
export const SUPPORTER_CODE_PATTERN = /^[0-9a-f]{32}$/;

function readCode(): string | null {
    try {
        const raw = window.localStorage.getItem(SUPPORTER_CODE_STORAGE_KEY);
        return raw && SUPPORTER_CODE_PATTERN.test(raw) ? raw : null;
    } catch {
        // Private windows and blocked storage throw; the page still thanks them.
        return null;
    }
}

export function SupporterCode() {
    const { plans: { THANKS_PAGE } } = useSiteData();
    // null on the server and the first client render, so hydration matches.
    const [code, setCode] = useState<string | null | undefined>(undefined);
    const [copied, setCopied] = useState(false);
    useEffect(() => setCode(readCode()), []);

    if (code === undefined) return <div className="min-h-[148px]" aria-hidden />;
    if (code === null) {
        return (
            <p className="max-w-[640px] text-[17px] leading-[1.6] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                {THANKS_PAGE.noCode}
            </p>
        );
    }

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div className="max-w-[640px]">
            <div className="rounded-2xl p-5 md:p-6 surface-card" style={{ boxShadow: 'inset 0 0 0 1px var(--card-border)' }}>
                <div className="text-[13px] font-medium" style={{ color: 'var(--muted)' }}>
                    {THANKS_PAGE.codeLabel}
                </div>
                <div className="mt-2 flex items-center gap-3">
                    <code className="min-w-0 flex-1 truncate font-mono text-[18px] tracking-[0.02em] md:text-[20px]" style={{ color: 'var(--fg)' }}>
                        {code}
                    </code>
                    <button type="button" onClick={copy} className="plan-pill shrink-0" aria-live="polite">
                        {copied ? THANKS_PAGE.copied : THANKS_PAGE.copy}
                    </button>
                </div>
                <p className="mt-3 text-[13px] leading-[1.5] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                    {THANKS_PAGE.codeHint}
                </p>
            </div>
            <a href={supporterAppLink(code)} className="plan-pill plan-pill--pri mt-5">
                {THANKS_PAGE.open}
            </a>
        </div>
    );
}
