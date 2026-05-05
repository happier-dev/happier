import { MotionConfig } from 'framer-motion';
import { Nav } from './sections/Nav';
import { Hero } from './sections/Hero';
import { ProviderStrip } from './sections/ProviderStrip';
import { RemoteLaunchPillar } from './sections/RemoteLaunchPillar';
import { DirectSessionsPillar } from './sections/DirectSessionsPillar';
import { VoicePillar } from './sections/VoicePillar';
import { ParallelPillar } from './sections/ParallelPillar';
import { SelfHostSecurity } from './sections/SelfHostSecurity';
import { GetStarted } from './sections/GetStarted';
import { Footer } from './sections/Footer';
import { TerminalBackground } from './sections/TerminalBackground';

export function App() {
    return (
        <MotionConfig reducedMotion="user">
            <TerminalBackground />
            <div className="grain-overlay" aria-hidden />
            <Nav />
            <main className="relative z-[2]">
                <Hero />
                <RemoteLaunchPillar />
                <DirectSessionsPillar />
                <VoicePillar />
                <ParallelPillar />
                <ProviderStrip />
                <SelfHostSecurity />
                <GetStarted />
            </main>
            <Footer />
        </MotionConfig>
    );
}
