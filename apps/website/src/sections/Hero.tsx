import { useTheme } from '../components/ThemeContext';
import { RevealText } from '../components/RevealText';
import { HeroHeadline } from '../components/HeroHeadline';
import { InstallCommand } from '../components/InstallCommand';
import { DownloadBadges } from '../components/DownloadBadges';
import { DownloadStats } from '../components/DownloadStats';
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
                        className="absolute inset-y-0 left-0 w-full lg:w-[58%]"
                        style={{
                            background:
                                'linear-gradient(to right, #050507 0%, rgba(5,5,7,0.92) 35%, rgba(5,5,7,0.45) 70%, rgba(5,5,7,0) 100%)',
                        }}
                    />
                    <div
                        className="absolute inset-x-0 bottom-0 h-1/3"
                        style={{ background: 'linear-gradient(to bottom, transparent 0%, var(--bg) 100%)' }}
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
                        style={{ background: 'linear-gradient(to bottom, transparent 0%, var(--bg) 100%)' }}
                    />
                </div>
            </div>

            <Nav />

            <div className="relative mx-auto grid min-h-[78vh] max-w-[1460px] grid-cols-1 content-center items-center gap-10 px-6 pb-0 pt-20 lg:grid-cols-12 lg:gap-12 lg:px-10 lg:pb-0 lg:pt-24">
                {/* Left — copy */}
                <div className="lg:col-span-6">
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

                    <div className="mt-5 lg:hidden">
                        <ProviderMarkRow size={18} />
                    </div>

                    <div className="mt-8 flex flex-col items-start gap-3">
                        <InstallCommand />
                    </div>

                    <div className="mt-4">
                        <DownloadBadges webApp />
                    </div>

                    <div className="mt-4">
                        <DownloadStats />
                    </div>
                </div>

                {/* Right — provider cloud over the planet. Pulled to the right edge
                    so it keeps clear of the headline at every desktop width. */}
                <div className="hidden lg:col-span-6 lg:block">
                    <div className="relative ml-auto aspect-[1.08] w-full max-w-[520px] lg:max-w-[660px] lg:-translate-y-6 xl:max-w-[760px]">
                        <HeroStage />
                    </div>
                </div>
            </div>
        </section>
    );
}
