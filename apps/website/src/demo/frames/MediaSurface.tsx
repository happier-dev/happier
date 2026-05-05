import { AnimatePresence, motion } from 'framer-motion';

/**
 * Describes the media a device frame should display for the active beat.
 * `kind: 'video'` autoplays muted+looped; `kind: 'image'` renders a still.
 *
 * `poster` lets video beats show a still during loading (good for first paint
 * + reduced-motion). Use a still from the same session.
 */
export type MediaDescriptor =
    | { kind: 'image'; src: string; alt?: string }
    | { kind: 'video'; src: string; poster?: string; alt?: string };

type Props = {
    media: MediaDescriptor | null;
    /**
     * When the media URL changes, cross-fade between old and new. The key is
     * derived from `media.src` so identity-equal stills don't re-mount.
     */
    className?: string;
};

const FADE = { duration: 0.22, ease: [0.2, 0, 0, 1] as const };

/**
 * Renders the active surface media inside a device frame's screen area.
 * Cross-fades on media change. No padding / chrome — the frame above
 * provides the bezel.
 *
 * Tight 220ms cross-fade matches the cinematic stage's high-paced rhythm
 * (devices move with ~450ms springs; media swaps faster so the transition
 * reads as "scene change", not "asset reload").
 */
export function MediaSurface({ media, className }: Props) {
    return (
        <div className={`relative h-full w-full overflow-hidden ${className ?? ''}`}>
            <AnimatePresence initial={false} mode="popLayout">
                {media ? (
                    <motion.div
                        key={media.src}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={FADE}
                        className="absolute inset-0"
                    >
                        {media.kind === 'video' ? (
                            <video
                                src={media.src}
                                poster={media.poster}
                                aria-label={media.alt}
                                autoPlay
                                loop
                                muted
                                playsInline
                                preload="metadata"
                                className="h-full w-full object-cover object-top"
                            />
                        ) : (
                            <img
                                src={media.src}
                                alt={media.alt ?? ''}
                                className="h-full w-full object-cover object-top"
                                loading="lazy"
                                decoding="async"
                            />
                        )}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
