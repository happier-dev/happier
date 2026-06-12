import { PROVIDERS } from '../data/providers';
import type { ProviderId } from '../data/providers';
import { useTheme } from '../components/ThemeContext';

type Placement = {
    providerId: ProviderId;
    /** Top position, percentage of parent stage. */
    top: string;
    /** Left position, percentage of parent stage. */
    left: string;
    /** Logo glyph size in px. */
    size: number;
    /** Subtle rotation. */
    tilt: number;
    /** Float animation delay offset (ms). */
    delay: number;
    /** Optional animation duration override. */
    duration?: number;
};

// Hand-tuned placements so the logos read as a wider orbital field over the
// planet instead of collapsing into the same center-right pocket.
const PLACEMENTS: ReadonlyArray<Placement> = [
    { providerId: 'claude', top: '22%', left: '15%', size: 44, tilt: -6, delay: 0, duration: 7200 },
    { providerId: 'codex', top: '18%', left: '45%', size: 40, tilt: 7, delay: 240, duration: 6800 },
    { providerId: 'opencode', top: '42%', left: '38%', size: 34, tilt: -4, delay: 620, duration: 7600 },
    { providerId: 'pi', top: '42%', left: '9%', size: 32, tilt: 4, delay: 340, duration: 6400 },
    { providerId: 'cursor', top: '69%', left: '12%', size: 34, tilt: -2, delay: 520, duration: 7000 },
    { providerId: 'copilot', top: '59%', left: '79%', size: 31, tilt: -7, delay: 920, duration: 7100 },
    { providerId: 'kimi', top: '53%', left: '57%', size: 32, tilt: -5, delay: 1080, duration: 7800 },
    { providerId: 'qwen', top: '60%', left: '30%', size: 28, tilt: 5, delay: 760, duration: 6900 },
    { providerId: 'auggie', top: '88%', left: '36%', size: 34, tilt: -3, delay: 1320, duration: 8100 },
    { providerId: 'gemini', top: '80%', left: '67%', size: 28, tilt: -8, delay: 1180, duration: 6500 },
    { providerId: 'kilo', top: '32%', left: '69%', size: 32, tilt: 2, delay: 460, duration: 8300 },
    { providerId: 'kiro', top: '72%', left: '45%', size: 26, tilt: 3, delay: 560, duration: 7400 },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Scatters provider logos around the hero stage, each floating independently.
 * Sits BEHIND the device screenshots (lower z-index) so the phones/desktops stay primary.
 */
export function ProviderScatter({ visible = true }: Readonly<{ visible?: boolean }>) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const color = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(10,10,11,0.88)';

    return (
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden>
            {PLACEMENTS.map((placement) => {
                const provider = PROVIDER_BY_ID.get(placement.providerId);
                if (!provider) return null;
                return (
                    <div
                        key={placement.providerId}
                        className="provider-float provider-glyph absolute"
                        style={
                            {
                                top: placement.top,
                                left: placement.left,
                                width: placement.size,
                                height: placement.size,
                                color,
                                opacity: visible ? 1 : 0,
                                transition:
                                    'color 700ms ease, opacity 900ms cubic-bezier(0.16,1,0.3,1)',
                                ['--tilt' as string]: `${placement.tilt}deg`,
                                ['--delay' as string]: `${placement.delay}ms`,
                                ['--float-duration' as string]: `${placement.duration ?? 6000}ms`,
                            } as never
                        }
                        title={provider.name}
                    >
                        {provider.logo}
                    </div>
                );
            })}
        </div>
    );
}
