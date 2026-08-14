import { useTheme } from '../components/ThemeContext';
import { RevealText } from '../components/RevealText';
import { InstallCommand } from '../components/InstallCommand';
import { DiscordMembers } from '../components/DiscordMembers';
import { Picture } from '../components/Picture';
import { rich } from '../i18n/rich';
import { PAGE_PROSE } from '../data/pageProse';

export function CallToAction() {
    const { theme } = useTheme();
    const bg = theme === 'dark' ? 'heroBackdropDark' : 'heroBackdropLight';

    return (
        <section className="relative isolate overflow-hidden" data-section="call-to-action">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="relative overflow-hidden rounded-[28px] border" style={{ borderColor: 'var(--card-border)' }}>
                    <Picture
                        id={bg}
                        alt=""
                        aria-hidden
                        className="absolute inset-0 h-full w-full"
                        imgClassName="h-full w-full object-cover"
                        style={{ objectPosition: '50% 30%', opacity: 0.85 }}
                    />
                    <div
                        className="absolute inset-0"
                        style={{
                            // Scrim colour is always the page colour; only the ramp
                            // differs by theme, so it reads var(--bg) rather than
                            // repeating the channels.
                            background:
                                theme === 'dark'
                                    ? 'linear-gradient(180deg, color-mix(in srgb, var(--bg) 35%, transparent) 0%, color-mix(in srgb, var(--bg) 80%, transparent) 100%)'
                                    : 'linear-gradient(180deg, color-mix(in srgb, var(--bg) 15%, transparent) 0%, color-mix(in srgb, var(--bg) 70%, transparent) 100%)',
                        }}
                    />

                    <div className="relative px-8 py-20 text-center md:px-16 md:py-28">
                        <RevealText
                            as="h2"
                            text={'Open source. Yours forever.'}
                            className="mx-auto max-w-[720px] font-display text-[36px] font-normal leading-[1.08] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                            stagger={60}
                        />
                        <p
                            className="mx-auto mt-6 max-w-[520px] text-[17px] leading-[1.55] md:text-[18px]"
                            style={{ color: 'var(--muted)' }}
                        >{rich(PAGE_PROSE.callToAction.p0)}</p>
                        {/* Install command first, web app second. The closing CTA's job
                            is to get a command onto the machine the agent will run on;
                            the web app is only useful once a machine is paired. */}
                        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
                            <InstallCommand />
                            <a
                                href="https://app.happier.dev/"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-2 rounded-2xl border px-6 py-3.5 text-[15px] font-semibold"
                                style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
                            >
                                Already paired? Open the web app
                                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 8h10" />
                                    <path d="M9 4l4 4-4 4" />
                                </svg>
                            </a>
                        </div>
                        <div className="mt-8 flex justify-center">
                            <DiscordMembers />
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
