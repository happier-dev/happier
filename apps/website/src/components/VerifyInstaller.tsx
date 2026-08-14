import {
    INSTALL_SCRIPT_PS1_URL,
    INSTALL_SCRIPT_URL,
    RELEASE_PUBKEY,
    RELEASE_PUBKEY_ID,
    RELEASE_PUBKEY_URL,
} from '../data/downloads';

/**
 * The "why should I pipe your script into my shell" disclosure.
 *
 * This is the single biggest unanswered objection on the page for the exact
 * developer the product targets — someone who self-hosts, cares about E2EE, and
 * has been told for a decade not to run `curl … | bash`. Answering it costs one
 * collapsed block; not answering it costs the install.
 *
 * Everything claimed here is verifiable in public/install.sh:
 *   - line 25-29   the minisign public key compiled into the script
 *   - line 31      the same key served at /happier-release.pub
 *   - line 2479-92 sha256 of the release archive checked against the published
 *                  checksums file, hard-fail on mismatch
 *   - line 2494-2501 minisign -Vm on that checksums file, hard-fail if minisign
 *                  cannot be obtained or the signature does not verify
 *   - line 2118-99 minisign itself is bootstrapped from a pinned upstream
 *                  release whose sha256 is checked before use
 *
 * Rendered as a native <details> rather than React state so it is present in the
 * prerendered HTML, readable with JavaScript disabled, and findable with the
 * browser's own in-page search.
 */
export function VerifyInstaller({ windowsShell = false }: { windowsShell?: boolean }) {
    const scriptUrl = windowsShell ? INSTALL_SCRIPT_PS1_URL : INSTALL_SCRIPT_URL;

    return (
        <details className="group max-w-[560px]">
            <summary
                className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium transition-opacity hover:opacity-100"
                style={{ color: 'var(--muted)' }}
            >
                <svg
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                >
                    <path d="M8 1.5 2.5 3.8v4c0 3.2 2.2 6.1 5.5 6.9 3.3-.8 5.5-3.7 5.5-6.9v-4L8 1.5Z" />
                    <path d="m5.8 7.9 1.6 1.6 3-3.2" />
                </svg>
                <span>Signed releases — verify before you run it</span>
                <svg
                    viewBox="0 0 16 16"
                    className="h-3 w-3 shrink-0 transition-transform group-open:rotate-180"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                >
                    <path d="M4 6l4 4 4-4" />
                </svg>
            </summary>

            <div
                className="mt-3 rounded-2xl border p-4 text-[13px] leading-[1.6]"
                style={{ borderColor: 'var(--card-border)', color: 'var(--muted)' }}
            >
                <p>
                    The installer does not trust its own download. It fetches the release archive
                    and the published <code className="font-mono">checksums.txt</code>, checks the
                    archive&rsquo;s SHA-256 against it, then verifies that checksums file with{' '}
                    <a
                        href="https://jedisct1.github.io/minisign/"
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >
                        minisign
                    </a>{' '}
                    against a key that ships inside the script. Either check failing aborts the
                    install before anything is written to disk.
                </p>

                <p className="mt-3">Signing key {RELEASE_PUBKEY_ID}:</p>
                <pre
                    className="mt-1.5 overflow-x-auto rounded-xl border px-3 py-2 font-mono text-[11.5px] leading-[1.5]"
                    style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
                >
                    <code>{RELEASE_PUBKEY}</code>
                </pre>
                <p className="mt-1.5">
                    It is also served at{' '}
                    <a
                        href={RELEASE_PUBKEY_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >
                        happier.dev/happier-release.pub
                    </a>
                    . The two should be identical — if they are not, do not install.
                </p>

                <p className="mt-3">Prefer not to pipe anything into a shell? Don&rsquo;t:</p>
                <pre
                    className="mt-1.5 overflow-x-auto rounded-xl border px-3 py-2 font-mono text-[11.5px] leading-[1.6]"
                    style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
                >
                    <code>
                        {windowsShell
                            ? 'iwr https://happier.dev/install.ps1 -useb -OutFile install.ps1\nnotepad install.ps1   # read it first\n.\\install.ps1'
                            : 'curl -fsSL https://happier.dev/install.sh -o happier-install.sh\nless happier-install.sh   # read it first\nbash happier-install.sh'}
                    </code>
                </pre>

                <p className="mt-3">
                    <a
                        href={scriptUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >
                        Read the script
                    </a>{' '}
                    ·{' '}
                    <a
                        href="https://docs.happier.dev/security"
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >
                        Security model
                    </a>
                </p>
            </div>
        </details>
    );
}
