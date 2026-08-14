import { useCallback, useMemo, useRef, useState } from 'react';
import {
    INSTALL_COMMAND_UNIX,
    INSTALL_COMMAND_WINDOWS,
} from '../data/downloads';
import { usePlatform, type Platform } from './usePlatform';
import { trackInstallCommandCopied, type CtaLocation } from '../analytics/events';
import { locationOf } from '../analytics/location';

const OS_LABEL: Record<Platform, string> = {
    mac: 'macOS',
    windows: 'Windows',
    linux: 'Linux',
    ios: 'macOS',
    ipados: 'macOS',
    android: 'macOS',
    unknown: 'macOS',
};

export function commandFor(platform: Platform): string {
    return platform === 'windows' ? INSTALL_COMMAND_WINDOWS : INSTALL_COMMAND_UNIX;
}

/**
 * The install one-liner, auto-selected for the visitor's OS.
 *
 * Two things changed from the version this replaces:
 *
 *   1. The whole chip used to be a single <button>, so the command text itself
 *      could not be selected with a mouse — dragging across it started a click,
 *      not a selection. Anyone who wanted to read or partially copy the command
 *      could not. The command is now inert text and only the copy affordance is
 *      a control.
 *   2. `aria-live` on the copy state, so a screen-reader user gets confirmation
 *      that something happened. Previously the only feedback was a colour
 *      change on an icon.
 *
 * On a phone this component is the wrong answer entirely — see
 * <HandoffToComputer />. Callers decide; this one just renders a command.
 */
export function InstallCommand({
    platform: forced,
    location,
}: {
    platform?: Platform;
    /**
     * Which block of the page this instance is in. Falls back to the nearest
     * `[data-cta-location]` / `[data-section]` ancestor when omitted, which is
     * how the same component can be dropped into a new page without an
     * analytics edit.
     */
    location?: CtaLocation;
} = {}) {
    const detected = usePlatform();
    const platform = forced ?? detected;
    const command = useMemo(() => commandFor(platform), [platform]);
    const [copied, setCopied] = useState(false);
    const root = useRef<HTMLDivElement | null>(null);

    /**
     * THE conversion event. This is the one interaction the whole site exists to
     * cause, and until now `trackInstallCommandCopied` had no call site at all —
     * the emitter was written, typed, guarded by a test, and never invoked.
     *
     * `succeeded` is not decoration. `navigator.clipboard.writeText` rejects
     * over plain HTTP, inside several embedded webviews, and whenever the
     * permission is denied — and the UI's only feedback is a checkmark that
     * never appears. Without this flag a copy button that is broken for a whole
     * class of visitor is indistinguishable from a button nobody wanted.
     */
    const onCopy = useCallback(async () => {
        let succeeded = true;
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch {
            /* clipboard denied — the text is selectable, which is the fallback */
            succeeded = false;
        }
        trackInstallCommandCopied({
            platform,
            form: 'oneliner',
            variant: 'stable',
            location: location ?? locationOf(root.current),
            succeeded,
        });
    }, [command, platform, location]);

    return (
        <div
            ref={root}
            className="inline-flex w-auto max-w-full items-center gap-2.5 rounded-2xl border px-4 py-3 font-mono text-[12.5px] md:text-[13px]"
            style={{ color: 'var(--fg)', background: 'transparent', borderColor: 'var(--card-border)' }}
        >
            <span aria-hidden style={{ color: 'var(--muted)' }}>
                $
            </span>
            <code className="truncate text-left">{command}</code>
            <button
                type="button"
                onClick={onCopy}
                className="ml-1 shrink-0 opacity-60 transition-opacity hover:opacity-100"
                aria-label={`Copy the ${OS_LABEL[platform]} install command`}
            >
                {copied ? (
                    <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M4 10.5l4 4 8-8" />
                    </svg>
                ) : (
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="6" y="6" width="10" height="10" rx="2" />
                        <path d="M4 14V5a1 1 0 0 1 1-1h9" />
                    </svg>
                )}
            </button>
            <span className="sr-only" role="status" aria-live="polite">
                {copied ? 'Install command copied' : ''}
            </span>
        </div>
    );
}
