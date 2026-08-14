import { ThemeProvider } from '../components/ThemeContext';
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
        <ThemeProvider>
            <div className="relative min-h-screen">
                <TerminalBackground />
                <main className="relative z-[2]">
                    <Hero />
                    <HeroShowcase />
                    <GetStarted />
                    <AlternatingFeatures />
                    <FeatureGrid />
                    <TabbedExplorer />
                    <SelfHost />
                    {/* Objection then reassurance, both before the closing CTA:
                        a visitor who reaches the install command should have
                        already had "why not Remote Control?" and "is this free?"
                        answered rather than carrying them past the button. */}
                    <VsRemoteControl />
                    <Faq />
                    <CallToAction />
                </main>
                <Footer />
            </div>
        </ThemeProvider>
    );
}
