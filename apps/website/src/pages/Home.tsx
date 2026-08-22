import { Island } from '../islands';
import { TerminalBackground } from '../components/TerminalBackground';
import { Hero } from '../sections/Hero';
import { HeroShowcase } from '../sections/HeroShowcase';
import { GetStarted } from '../sections/GetStarted';
import { AlternatingFeatures } from '../sections/AlternatingFeatures';
import { FeatureGrid } from '../sections/FeatureGrid';
import { TabbedExplorer } from '../sections/TabbedExplorer';
import { SelfHost } from '../sections/SelfHost';
import { VsRemoteControl } from '../sections/VsRemoteControl';
import { Faq } from '../sections/Faq';
import { CallToAction } from '../sections/CallToAction';
import { Footer } from '../sections/Footer';

/**
 * The homepage, unchanged in composition — lifted out of App.tsx when the site
 * grew a second route so that App became a router and nothing else.
 */
export function Home() {
    return (
            <div className="relative min-h-screen">
                <Island name="terminal-background" component={TerminalBackground} />
                <main className="relative z-[2]">
                    <Hero />
                    <Island name="hero-showcase" component={HeroShowcase} />
                    <GetStarted />
                    <AlternatingFeatures />
                    <FeatureGrid />
                    <Island name="tabbed-explorer" component={TabbedExplorer} />
                    <Island name="self-host" component={SelfHost} />
                    {/* Objection then reassurance, both before the closing CTA:
                        a visitor who reaches the install command should have
                        already had "why not Remote Control?" and "is this free?"
                        answered rather than carrying them past the button. */}
                    <VsRemoteControl />
                    <Faq />
                    <Island name="call-to-action" component={CallToAction} />
                </main>
                <Island name="footer" component={Footer} />
            </div>
    );
}
