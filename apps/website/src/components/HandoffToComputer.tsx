import { useCallback, useEffect, useState } from 'react';
import { INSTALL_COMMAND_UNIX } from '../data/downloads';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

const SHARE_TITLE = 'Set up Happier on my computer';
const SHARE_TEXT = [
    'Run this on the computer where your code lives:',
    '',
    INSTALL_COMMAND_UNIX,
    '',
    'Windows: iwr https://happier.dev/install.ps1 -useb | iex',
    '',
    'Then open Happier on your phone and sign in to the same account.',
].join('\n');

const MAILTO_HREF =
    `mailto:?subject=${encodeURIComponent(SHARE_TITLE)}&body=${encodeURIComponent(SHARE_TEXT)}`;

/**
 * The phone visitor's primary action.
 *
 * A phone cannot run `curl … | bash`, and the funnel says what happens when we
 * pretend otherwise: 56% of installs open the app on exactly one day, median
 * lifetime two minutes, because they arrived from a store listing with no
 * machine to pair. Happier is worth nothing until a computer is running the
 * background service, so on a handheld the page's job is to move the visitor to
 * a keyboard — not to hand them another app icon.
 *
 * Three routes out, cheapest-first, no backend behind any of them:
 *   1. The native share sheet, when the browser has one. On iOS this includes
 *      AirDrop, which puts the command on the visitor's Mac in two taps —
 *      by a distance the best handoff available to a static site.
 *   2. A mailto: with the command in the body. Works on every device ever made.
 *   3. Copy to clipboard, for anyone already on a synced-clipboard setup.
 *
 * The app-store link is deliberately demoted to a secondary line: it is the
 * right action *after* a machine is set up, not before.
 */
export function HandoffToComputer() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const [state, setState] = useState<'idle' | 'copied'>('idle');

    // The page is prerendered, so `navigator.share` cannot be read during
    // render: the server would resolve it to false and the client to true, and
    // React 19 would tear down the hydrated subtree over the mismatch. Start on
    // the mailto branch — which is also the correct no-JS fallback baked into
    // the prerendered HTML — and upgrade to the share sheet in an effect.
    const [canShare, setCanShare] = useState(false);
    useEffect(() => {
        setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    }, []);

    const onShare = useCallback(async () => {
        try {
            await navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT });
        } catch {
            /* dismissed */
        }
    }, []);

    const onCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(INSTALL_COMMAND_UNIX);
            setState('copied');
            setTimeout(() => setState('idle'), 1800);
        } catch {
            /* clipboard denied */
        }
    }, []);

    return (
        <div
            className="w-full max-w-[440px] rounded-2xl border p-4"
            style={{ borderColor: 'var(--card-border)', background: 'var(--card)' }}
        >
            <p className="text-[15px] font-semibold leading-[1.35]" style={{ color: 'var(--fg)' }}>{rich(PAGE_PROSE.handoffToComputer.p0)}</p>
            <p className="mt-1.5 text-[13.5px] leading-[1.55]" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.handoffToComputer.p1)}</p>

            <pre
                className="mt-3.5 overflow-x-auto rounded-xl border px-3 py-2.5 font-mono text-[11.5px] leading-[1.5]"
                style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
            >
                <code>{INSTALL_COMMAND_UNIX}</code>
            </pre>

            <div className="mt-3.5 flex flex-wrap gap-2">
                {canShare ? (
                    <button
                        type="button"
                        onClick={onShare}
                        className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-semibold"
                        style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                    >{rich(PAGE_PROSE.handoffToComputer.p2, { 1: () => <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M8 10.5V2m0 0L5.2 4.8M8 2l2.8 2.8" />
                            <path d="M3 9.5v3a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5v-3" />
                        </svg> })}</button>
                ) : (
                    <a
                        href={MAILTO_HREF}
                        className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-semibold"
                        style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                    >{rich(PAGE_PROSE.handoffToComputer.p3)}</a>
                )}

                <button
                    type="button"
                    onClick={onCopy}
                    className="inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[14px] font-medium"
                    style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
                >
                    {state === 'copied' ? 'Copied' : 'Copy command'}
                </button>
            </div>

            <span className="sr-only" role="status" aria-live="polite">
                {state === 'copied' ? 'Install command copied' : ''}
            </span>
        </div>
    );
}
