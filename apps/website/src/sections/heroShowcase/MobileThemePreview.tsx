import { useEffect, useMemo, useState } from 'react';
import { PhoneFrame } from './PhoneFrame';
import { MOBILE_THEME_PREVIEWS, resolveNextThemePreviewIndex } from './themePreviews';

const REVEAL_DURATION_MS = 600;

export function MobileThemePreview() {
    const [committedIndex, setCommittedIndex] = useState(0);
    const [revealingIndex, setRevealingIndex] = useState<number | null>(null);
    const activeIndex = revealingIndex ?? committedIndex;
    const committedPreview = MOBILE_THEME_PREVIEWS[committedIndex];
    const revealingPreview = revealingIndex === null ? null : MOBILE_THEME_PREVIEWS[revealingIndex];

    useEffect(() => {
        if (revealingIndex === null) return;
        const timer = window.setTimeout(() => {
            setCommittedIndex(revealingIndex);
            setRevealingIndex(null);
        }, REVEAL_DURATION_MS);
        return () => {
            window.clearTimeout(timer);
        };
    }, [revealingIndex]);

    const selectPreview = (index: number) => {
        if (index === activeIndex) return;
        setRevealingIndex(index);
    };

    const advancePreview = () => {
        selectPreview(resolveNextThemePreviewIndex(activeIndex, MOBILE_THEME_PREVIEWS.length));
    };

    const swatches = useMemo(() => MOBILE_THEME_PREVIEWS, []);

    return (
        <div className="flex w-full flex-col items-center gap-5">
            <button
                type="button"
                className="group relative block min-h-[360px] w-full cursor-pointer appearance-none border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-4 focus-visible:ring-offset-black md:min-h-0"
                aria-label="Preview the next Happier mobile theme"
                onClick={advancePreview}
            >
                <PhoneFrame>
                    <img
                        src={committedPreview.src}
                        alt={committedPreview.label}
                        className="block h-full w-full select-none"
                        draggable={false}
                    />
                    {revealingPreview ? (
                        <img
                            key={revealingPreview.id}
                            src={revealingPreview.src}
                            alt=""
                            aria-hidden
                            className="theme-preview-reveal absolute inset-0 block h-full w-full select-none"
                            draggable={false}
                        />
                    ) : null}
                </PhoneFrame>
            </button>

            <div className="flex items-center justify-center gap-1.5" aria-label="Mobile theme previews">
                {swatches.map((preview, index) => {
                    const selected = index === activeIndex;
                    return (
                        <button
                            key={preview.id}
                            type="button"
                            aria-label={`Show ${preview.label}`}
                            aria-pressed={selected}
                            className="relative h-3 w-3 rounded-full border-0 bg-transparent p-0 outline-none transition-transform duration-200 hover:scale-110 focus-visible:ring-2 focus-visible:ring-white/75 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                            onClick={() => selectPreview(index)}
                        >
                            <span
                                className="absolute inset-0 rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_1px_4px_rgba(0,0,0,0.28)]"
                                style={{ backgroundColor: preview.swatch }}
                            />
                            {selected ? (
                                <span className="absolute inset-0 rounded-full ring-1 ring-white/55" />
                            ) : null}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
