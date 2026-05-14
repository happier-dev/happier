import { PROVIDERS } from '../data/providers';
import type { ProviderId } from '../data/providers';
import { useTheme } from '../components/ThemeContext';

type Placement = {
    providerId: ProviderId;
    /** Top position, percentage of parent stage. */
    top: string;
    /** Right position, percentage of parent stage. */
    right: string;
    /** Logo container size in px. */
    size: number;
    /** Subtle rotation. */
    tilt: number;
    /** Float animation delay offset (ms). */
    delay: number;
    /** Inner logo scale relative to its container. Defaults to 0.55. */
    innerScale?: number;
};

// Hand-tuned placements so the logos orbit the planet/devices without overlapping
// the headline area on the left.
const PLACEMENTS: ReadonlyArray<Placement> = [
    { providerId: 'claude',   top: '6%',  right: '32%', size: 44, tilt: -6, delay: 0 },
    { providerId: 'pi',       top: '19%', right: '59%', size: 36, tilt: 4,  delay: 300 },
    { providerId: 'opencode', top: '25%', right: '1%',  size: 52, tilt: -3, delay: 700, innerScale: 0.45 },
    { providerId: 'codex',    top: '18%', right: '82%', size: 40, tilt: 7,  delay: 200 },
    { providerId: 'copilot',  top: '49%', right: '10%', size: 36, tilt: -8, delay: 950 },
    { providerId: 'auggie',   top: '89%', right: '64%', size: 44, tilt: 2,  delay: 500 },
    { providerId: 'kimi',     top: '69%', right: '4%',  size: 38, tilt: -5, delay: 1100 },
    { providerId: 'qwen',     top: '84%', right: '82%', size: 32, tilt: 6,  delay: 850 },
    { providerId: 'kilo',     top: '98%', right: '30%', size: 42, tilt: -4, delay: 1400 },
    { providerId: 'kiro',     top: '99%', right: '49%', size: 30, tilt: 3,  delay: 600 },
    { providerId: 'gemini',   top: '92%', right: '9%',  size: 34, tilt: -7, delay: 1200 },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Scatters provider logos around the hero stage, each floating independently.
 * Sits BEHIND the device screenshots (lower z-index) so the phones/desktops stay primary.
 */
export function ProviderScatter() {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const tileStyle = {
        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(10,10,11,0.035)',
        border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(10,10,11,0.04)'}`,
        boxShadow: isDark
            ? '0 8px 24px -8px rgba(0,0,0,0.5)'
            : '0 8px 24px -8px rgba(10,10,11,0.12)',
        color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(10,10,11,0.85)',
        transition:
            'background-color 700ms ease, border-color 700ms ease, color 700ms ease, box-shadow 700ms ease',
    } as const;

    return (
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden>
            {PLACEMENTS.map((placement) => {
                const provider = PROVIDER_BY_ID.get(placement.providerId);
                if (!provider) return null;
                return (
                    <div
                        key={placement.providerId}
                        className="provider-float absolute"
                        style={
                            {
                                top: placement.top,
                                right: placement.right,
                                width: placement.size,
                                height: placement.size,
                                ['--tilt' as string]: `${placement.tilt}deg`,
                                ['--delay' as string]: `${placement.delay}ms`,
                            } as never
                        }
                    >
                        <div
                            className="grid h-full w-full place-items-center rounded-2xl backdrop-blur-md"
                            style={tileStyle}
                            title={provider.name}
                        >
                            <div
                                style={{
                                    width: `${(placement.innerScale ?? 0.55) * 100}%`,
                                    height: `${(placement.innerScale ?? 0.55) * 100}%`,
                                }}
                            >
                                {provider.logo}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
