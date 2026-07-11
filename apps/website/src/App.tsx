import { ThemeProvider } from './components/ThemeContext';
import { TerminalBackground } from './components/TerminalBackground';
import { Hero } from './sections/Hero';
import { HeroShowcase } from './sections/HeroShowcase';
import { GetStarted } from './sections/GetStarted';
import { AlternatingFeatures } from './sections/AlternatingFeatures';
import { FeatureGrid } from './sections/FeatureGrid';
import { TabbedExplorer } from './sections/TabbedExplorer';
import { SelfHost } from './sections/SelfHost';
import { CallToAction } from './sections/CallToAction';
import { Footer } from './sections/Footer';

export function App() {
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
                    <CallToAction />
                </main>
                <Footer />
            </div>
        </ThemeProvider>
    );
}
