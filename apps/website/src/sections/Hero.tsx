import { Island } from '../islands';
import { RevealText } from '../components/RevealText';
import { HeroHeadline } from '../components/HeroHeadline';
import { InstallCommand } from '../components/InstallCommand';
import { DownloadBadges } from '../components/DownloadBadges';
import { DownloadStats } from '../components/DownloadStats';
import { ProviderMarkRow } from '../components/ProviderMarkRow';
import { Nav } from './Nav';
import { HeroStage } from './HeroStage';
import { HeroBackdrop } from './HeroBackdrop';
import { useSiteData } from '../i18n/siteData';

/**
 * Hero — full-bleed planet background, nav floats over it, multi-provider
 * headline on the left, device screenshots + scattered providers on the right.
 */
export function Hero() {
    // Same source as the headline: HERO in src/data/pageProse.ts. It used to be
    // src/i18n/messages/en.ts, which has two locales in it — so this sentence,
    // the first one under the H1, was English on eight of the nine homepages.
    const { pageProse: { HERO } } = useSiteData();

    return (
        <section className="relative isolate overflow-hidden" data-section="hero">
            <Island name="hero-backdrop" component={HeroBackdrop} />

            <Island name="nav" component={Nav} />

            <div className="relative mx-auto grid min-h-[78vh] max-w-[1460px] grid-cols-1 content-center items-center gap-10 px-6 pb-0 pt-20 lg:grid-cols-12 lg:gap-12 lg:px-10 lg:pb-0 lg:pt-24">
                {/* Left — copy */}
                <div className="lg:col-span-6">
                    <HeroHeadline />

                    <div className="mt-7 max-w-[560px] text-[16px] leading-[1.55] md:text-[17px] lg:text-[18px]" style={{ color: 'var(--muted)' }}>
                        <RevealText
                            as="p"
                            text={HERO.subhead}
                            delay={525}
                            stagger={45}
                            className="font-sans tracking-normal"
                        />
                    </div>

                    {/* Tightened on mobile: this row, plus the install block below it,
                        put ~74px between the subhead and the first button — nearly three
                        times the 28px the subhead itself sits below the headline. */}
                    <div className="mt-3 lg:hidden">
                        <Island name="provider-mark-row" component={ProviderMarkRow} props={{ size: 18 }} />
                    </div>

                    <div className="mt-4 flex flex-col items-start gap-3 md:mt-8">
                        <Island name="install-command" component={InstallCommand} />
                    </div>

                    <div className="mt-4">
                        <Island name="download-badges" component={DownloadBadges} props={{ webApp: true }} />
                    </div>

                    <div className="mt-4">
                        <Island name="download-stats" component={DownloadStats} />
                    </div>
                </div>

                {/* Right — provider cloud over the planet. Pulled to the right edge
                    so it keeps clear of the headline at every desktop width. */}
                <div className="hidden lg:col-span-6 lg:block">
                    <div className="relative ml-auto aspect-[1.08] w-full max-w-[520px] lg:max-w-[660px] lg:-translate-y-6 xl:max-w-[760px]">
                        <Island name="hero-stage" component={HeroStage} />
                    </div>
                </div>
            </div>
        </section>
    );
}
