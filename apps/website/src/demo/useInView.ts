import { useEffect, useState, type RefObject } from 'react';

/**
 * `useInView` — true while `ref` is within the viewport (with rootMargin
 * slack). Used to gate each DeviceStage's `useScenarioDriver` so multiple
 * pillars on the same page don't fight over the shared demo store.
 *
 * Falls back to `true` on SSR and in environments without
 * IntersectionObserver so scenarios still run in that case.
 */
export function useInView(
    ref: RefObject<HTMLElement | null>,
    { rootMargin = '0px 0px' }: { rootMargin?: string } = {},
): boolean {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        if (typeof IntersectionObserver === 'undefined') {
            setVisible(true);
            return;
        }
        const obs = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    setVisible(entry.isIntersecting);
                }
            },
            { rootMargin, threshold: 0.15 },
        );
        obs.observe(node);
        return () => obs.disconnect();
    }, [ref, rootMargin]);

    return visible;
}
