/**
 * iPhone OS chrome overlays — status bar (time, signal, wifi, battery) at the
 * top, and home indicator at the bottom. Drawn ON TOP of the screen content
 * so when an existing screenshot fills the screen edge-to-edge it reads as a
 * real iPhone running the app instead of "the web app stuffed into a phone".
 *
 * Sizing notes for the 284×588 PhoneFrame inner screen:
 *   - Status bar height ≈ 32px (matches the dynamic-island vertical region)
 *   - Time text sits at left, vertically centered with the island
 *   - Signal/wifi/battery icons sit at right, vertically centered with the island
 *   - Home indicator: 5px tall, ~108px wide, 8px from bottom edge
 */

export function PhoneStatusBar() {
    return (
        <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-between px-6"
            style={{ height: 32 }}
        >
            <span className="text-[12px] font-semibold tracking-tight text-white">
                9:41
            </span>
            <div className="flex items-center gap-[4px] text-white">
                {/* Cellular signal — 4 ascending bars */}
                <svg width="14" height="9" viewBox="0 0 14 9" fill="none" aria-hidden>
                    <rect x="0" y="6" width="2" height="3" rx="0.4" fill="currentColor" />
                    <rect x="3.5" y="4" width="2" height="5" rx="0.4" fill="currentColor" />
                    <rect x="7" y="2" width="2" height="7" rx="0.4" fill="currentColor" />
                    <rect x="10.5" y="0" width="2" height="9" rx="0.4" fill="currentColor" />
                </svg>
                {/* Wi-Fi */}
                <svg width="14" height="10" viewBox="0 0 14 10" fill="currentColor" aria-hidden>
                    <path d="M7 1c2.6 0 4.95 1 6.7 2.6l-1.55 1.55A6.5 6.5 0 0 0 7 3.2 6.5 6.5 0 0 0 2.85 5.15L1.3 3.6A9.5 9.5 0 0 1 7 1Zm0 3.5c1.65 0 3.13.62 4.27 1.65l-1.55 1.55A4 4 0 0 0 7 6.7a4 4 0 0 0-2.72 1L2.73 6.15A6 6 0 0 1 7 4.5Zm0 3.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z" />
                </svg>
                {/* Battery — outline + fill + nub */}
                <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden>
                    <rect
                        x="0.5"
                        y="0.5"
                        width="18"
                        height="9"
                        rx="2"
                        ry="2"
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity="0.4"
                    />
                    <rect x="2" y="2" width="15" height="6" rx="1" ry="1" fill="currentColor" />
                    <rect
                        x="19.5"
                        y="3"
                        width="1.5"
                        height="4"
                        rx="0.5"
                        ry="0.5"
                        fill="currentColor"
                        fillOpacity="0.4"
                    />
                </svg>
            </div>
        </div>
    );
}

export function PhoneHomeIndicator() {
    return (
        <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center justify-center"
            style={{ height: 18 }}
        >
            <div
                className="rounded-full bg-white/85 dark:bg-white/85"
                style={{ width: 108, height: 4 }}
            />
        </div>
    );
}
