import { ThemeProvider } from './components/ThemeContext';
import { TerminalBackground } from './components/TerminalBackground';
import { Hero } from './sections/Hero';
import { HeroShowcase } from './sections/HeroShowcase';
import { AlternatingFeatures } from './sections/AlternatingFeatures';
import { CallToAction } from './sections/CallToAction';
import { Footer } from './sections/Footer';

export function App() {
    return (
        <ThemeProvider>
            <div className="relative min-h-screen">
                {/* Ambient matrix-style noise behind the page. The hero section's own
                    opaque planet image covers this in the hero region; the matrix
                    reads through in the sections below. */}
                <TerminalBackground />
                {/* Nav lives inside the Hero so it floats over the planet background. */}
                <main className="relative z-[2]">
                    <Hero />
                    <HeroShowcase />
                    <AlternatingFeatures />
                    <CallToAction />
                </main>
                <Footer />
            </div>
        </ThemeProvider>
    );
}
