'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

import { capturePageview, isAnalyticsActive, optIn, optOut, readOptOut, start } from './analytics';

/**
 * Boots analytics and records one pageview per route.
 *
 * Split from AnalyticsNotice so the notice can render its switch without
 * depending on when the lazy posthog-js chunk resolves.
 */
export function Analytics() {
    const pathname = usePathname();

    useEffect(() => {
        let cancelled = false;
        void start().then(() => {
            if (!cancelled) capturePageview();
        });
        return () => {
            cancelled = true;
        };
    }, [pathname]);

    return null;
}

/**
 * The disclosure and the opt-out, in one footer line.
 *
 * Deliberately not a cookie banner. A modal asking consent for something we do
 * not do — we set no cookie and store no identifier — costs every reader a click
 * and buys them nothing. What we owe them is a true sentence and a working
 * switch, permanently available, where people look for legal text.
 *
 * Opting out takes effect immediately for the rest of this page load and for
 * every future visit. The record of that choice is the only thing this site ever
 * writes to a device.
 */
export function AnalyticsNotice() {
    // Read on the client only: the server has no localStorage, and rendering a
    // guess would swap the label under the reader on hydration.
    const [mounted, setMounted] = useState(false);
    const [optedOut, setOptedOut] = useState(false);
    const [active, setActive] = useState(false);

    useEffect(() => {
        setMounted(true);
        setOptedOut(readOptOut());
        setActive(isAnalyticsActive());
    }, []);

    if (!mounted) return null;

    function toggle() {
        if (optedOut) {
            optIn();
            setOptedOut(false);
        } else {
            optOut();
            setOptedOut(true);
        }
    }

    return (
        <p className="fd-analytics-notice">
            <span>
                {optedOut
                    ? 'Analytics are off for this browser.'
                    : active
                      ? 'Anonymous, cookieless page analytics — no identifier, no profile, first-party only.'
                      : 'Analytics are off: your browser sends Do Not Track or Global Privacy Control.'}
            </span>{' '}
            {active || optedOut ? (
                <button type="button" onClick={toggle} className="fd-analytics-toggle">
                    {optedOut ? 'Turn on' : 'Turn off'}
                </button>
            ) : null}
        </p>
    );
}
