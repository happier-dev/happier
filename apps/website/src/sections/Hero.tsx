import { useTheme } from '../components/ThemeContext';
import { RevealText } from '../components/RevealText';
import { HeroHeadline } from '../components/HeroHeadline';
import { InstallCommand } from '../components/InstallCommand';
import { DownloadBadges } from '../components/DownloadBadges';
import { ProviderMarkRow } from '../components/ProviderMarkRow';
import { Nav } from './Nav';
import { HeroStage } from './HeroStage';

/**
 * Hero — full-bleed planet background, nav floats over it, multi-provider
 * headline on the left, device screenshots + scattered providers on the right.
 */
export function Hero() {
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    return (
        <section className="relative isolate overflow-hidden">
            {/* Theme-aware background layers — both rendered, cross-faded on toggle.
                Gives the page a smooth day/night transition. */}
            <div className="pointer-events-none absolute inset-0 -z-10">
                {/* Dark theme layer — planet over near-black bg */}
                <div
                    className="absolute inset-0"
                    style={{ opacity: isDark ? 1 : 0, transition: 'opacity 700ms ease' }}
                >
                    <img
                        src="/images/background5_black_jpg60.jpg"
                        alt=""
                        aria-hidden
                        className="absolute inset-0 h-full w-full object-cover"
                        style={{ objectPosition: '80% 20%' }}
                    />
                    <div
                        className="absolute inset-y-0 left-0 w-full md:w-[58%]"
                        style={{
                            background:
                                'linear-gradient(to right, #050507 0%, rgba(5,5,7,0.92) 35%, rgba(5,5,7,0.45) 70%, rgba(5,5,7,0) 100%)',
                        }}
                    />
                    <div
                        className="absolute inset-x-0 bottom-0 h-1/3"
                        style={{ background: 'linear-gradient(to bottom, transparent 0%, #050507 100%)' }}
                    />
                </div>
                {/* Light theme layer — sunrise planet over cream bg */}
                <div
                    className="absolute inset-0"
                    style={{ opacity: isDark ? 0 : 1, transition: 'opacity 700ms ease' }}
                >
                    <img
                        src="/images/background5_white_jpg60.jpg"
                        alt=""
                        aria-hidden
                        className="absolute inset-0 h-full w-full object-cover"
                        style={{ objectPosition: '80% 20%', filter: 'saturate(1.1)' }}
                    />
                    <div
                        className="absolute inset-x-0 bottom-0 h-1/4"
                        style={{ background: 'linear-gradient(to bottom, transparent 0%, #F7F5F0 100%)' }}
                    />
                </div>
            </div>

            <Nav />

            <div className="relative mx-auto grid min-h-[78vh] max-w-[1460px] grid-cols-1 content-center items-center gap-10 px-6 pb-0 pt-20 md:grid-cols-12 md:gap-6 md:px-10 md:pb-0 md:pt-24">
                {/* Left — copy */}
                <div className="md:col-span-6 lg:col-span-6">
                    <HeroHeadline />

                    <div className="mt-7 max-w-[560px] text-[16px] leading-[1.55] md:text-[17px] lg:text-[18px]" style={{ color: 'var(--muted)' }}>
                        <RevealText
                            as="p"
                            text={'The perfect client for your AI agents.\nOpen-source. End-to-end ~~~ encrypted. Self-hostable.'}
                            delay={525}
                            stagger={45}
                            className="font-sans tracking-normal"
                        />
                    </div>

                    <div className="mt-5 md:hidden">
                        <ProviderMarkRow size={18} />
                    </div>

                    <div className="mt-8 flex flex-col items-start gap-3 2xl:flex-row 2xl:items-center 2xl:gap-4">
                        <a
                            href="https://app.happier.dev/"
                            target="_blank"
                            rel="noreferrer"
                            className="group inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-[14px] font-semibold transition-transform hover:-translate-y-[1px]"
                            style={{
                                background: 'var(--fg)',
                                color: 'var(--bg)',
                                boxShadow: isDark
                                    ? '0 20px 60px -20px rgba(255, 255, 255, 0.22)'
                                    : '0 20px 60px -20px rgba(10, 10, 11, 0.35)',
                                // background and color use @property-animated vars (--fg, --bg);
                                // only transition box-shadow which is a hard-coded value.
                                transition: 'box-shadow 700ms ease',
                            }}
                        >
                            <span>Web app</span>
                            <svg viewBox="0 0 16 16" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 8h10" />
                                <path d="M9 4l4 4-4 4" />
                            </svg>
                        </a>
                        <InstallCommand />
                    </div>

                    <DownloadBadges />
                </div>

                {/* Right — provider cloud over the planet. */}
                <div className="hidden md:col-span-6 md:block lg:col-span-6">
                    <div className="relative mx-auto aspect-[1.08] w-full max-w-[520px] md:max-w-[760px] md:-translate-y-6 lg:-translate-x-2 lg:max-w-[860px]">
                        <HeroStage />
                    </div>
                </div>
            </div>
        </section>
    );
}
