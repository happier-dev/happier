import { APP_STORE_URL, ANDROID_APK_URL, WEB_APP_URL } from '../data/downloads';
import { HandoffToComputer } from './HandoffToComputer';
import { InstallCommand } from './InstallCommand';
import { VerifyInstaller } from './VerifyInstaller';
import { isHandheld, usePlatform } from './usePlatform';

/**
 * The single above-the-fold action block, resolved per device.
 *
 * What a visitor sees:
 *
 *   macOS / Linux    `curl -fsSL https://happier.dev/install | bash`, copyable,
 *                    with the signature disclosure directly under it, and
 *                    "already set up? open the web app" as the second option.
 *   Windows          the same, with the PowerShell one-liner and the PowerShell
 *                    two-step in the disclosure.
 *   unknown          identical to macOS. This is also what the prerenderer and
 *                    every crawler get, so the fold has real text in the HTML.
 *   iOS / iPadOS     <HandoffToComputer />, then the App Store link labelled as
 *                    the companion it is.
 *   Android          <HandoffToComputer />, then the APK link — because there is
 *                    no Play listing to send anyone to (see data/downloads.ts).
 */
export function PrimaryCta() {
    const platform = usePlatform();

    if (isHandheld(platform)) {
        return (
            <div className="flex flex-col items-start gap-4">
                <HandoffToComputer />
                <p className="text-[13px] leading-[1.55]" style={{ color: 'var(--muted)' }}>
                    Already have a machine set up?{' '}
                    {platform === 'android' ? (
                        <a
                            href={ANDROID_APK_URL}
                            className="font-medium underline underline-offset-2"
                            style={{ color: 'var(--fg)' }}
                        >
                            Get the Android app
                        </a>
                    ) : (
                        <a
                            href={APP_STORE_URL}
                            className="font-medium underline underline-offset-2"
                            style={{ color: 'var(--fg)' }}
                        >
                            Get the iOS app
                        </a>
                    )}{' '}
                    or{' '}
                    <a
                        href={WEB_APP_URL}
                        className="font-medium underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >
                        open it in this browser
                    </a>
                    .
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-start gap-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
                <InstallCommand />
                <a
                    href={WEB_APP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-2xl border px-4 py-3 text-[14px] font-medium transition-transform hover:-translate-y-[1px]"
                    style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
                >
                    Already set up? Open the app
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M3 8h10" />
                        <path d="M9 4l4 4-4 4" />
                    </svg>
                </a>
            </div>
            <VerifyInstaller windowsShell={platform === 'windows'} />
        </div>
    );
}
