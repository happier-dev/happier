import type { ReactNode } from 'react';

type PhoneFrameProps = {
    children: ReactNode;
};

/**
 * iPhone-style chrome built as three concentric, constant-width bands —
 * polished metal rail → black bezel → screen — the way a real device reads.
 *
 * Two ideas keep it honest:
 *
 *  1. Solid bands, not highlight strokes. The edge is a filled metal rail and
 *     a filled black bezel, so there are no stacked 1px inset highlights to
 *     show up as doubled "hairline" borders at the corners.
 *
 *  2. Apple continuous corners. Each band is clipped to a superellipse
 *     (figma-squircle, cornerSmoothing 0.6) rather than a plain circular
 *     `border-radius`. The clip paths use `objectBoundingBox` units (0..1),
 *     and because the frame's aspect ratio is fixed (1170/2532) the per-axis
 *     arc radii were pre-scaled so the corner stays symmetric at *any*
 *     rendered width — 190px in the mobile column or 370px on desktop.
 *
 * All thicknesses/radii are expressed in `cqw` (1cqw = 1% of the frame's own
 * width) via the container-query context on the wrapper, so the whole thing
 * scales as one rigid unit.
 */

// Superellipse outlines in objectBoundingBox space (0..1), one per band.
// Generated with figma-squircle for boxes at the 1170/2532 aspect:
//   rail   100   x 216.41  r 16.4   bezel 96 x 212.41 r 14.4   screen 91.2 x 207.61 r 12.0
// then normalised x/=W, y/=H. Concentric: screenR = bezelR − bezelPad, etc.
const RAIL_CLIP =
    'M 0.7376 0 c 0.091849 0 0.137773 0 0.172854 0.00826 a 0.164 0.075782 0 0 1 0.071671 0.033118 c 0.017875 0.016211 0.017875 0.037432 0.017875 0.079873 L 1 0.878749 c 0 0.042442 0 0.063663 -0.017875 0.079873 a 0.164 0.075782 0 0 1 -0.071671 0.033118 c -0.035082 0.00826 -0.081006 0.00826 -0.172854 0.00826 L 0.2624 1 c -0.091849 0 -0.137773 0 -0.172854 -0.00826 a 0.164 0.075782 0 0 1 -0.071671 -0.033118 c -0.017875 -0.016211 -0.017875 -0.037432 -0.017875 -0.079873 L 0 0.121251 c 0 -0.042442 0 -0.063663 0.017875 -0.079873 a 0.164 0.075782 0 0 1 0.071671 -0.033118 c 0.035082 -0.00826 0.081006 -0.00826 0.172854 -0.00826 Z';
const BEZEL_CLIP =
    'M 0.76 0 c 0.084008 0 0.126011 0 0.158099 0.007389 a 0.15 0.067793 0 0 1 0.065552 0.029627 c 0.016349 0.014502 0.016349 0.033486 0.016349 0.071454 L 1 0.891531 c 0 0.037968 0 0.056952 -0.016349 0.071454 a 0.15 0.067793 0 0 1 -0.065552 0.029627 c -0.032086 0.007389 -0.074091 0.007389 -0.158099 0.007389 L 0.24 1 c -0.084008 0 -0.126011 0 -0.158099 -0.007389 a 0.15 0.067793 0 0 1 -0.065552 -0.029627 c -0.016349 -0.014502 -0.016349 -0.033486 -0.016349 -0.071454 L 0 0.108469 c 0 -0.037968 0 -0.056952 0.016349 -0.071454 a 0.15 0.067793 0 0 1 0.065552 -0.029627 c 0.032086 -0.007389 0.074091 -0.007389 0.158099 -0.007389 Z';
const SCREEN_CLIP =
    'M 0.789474 0 c 0.073691 0 0.110536 0 0.138683 0.0063 a 0.131579 0.057801 0 0 1 0.057502 0.02526 c 0.014341 0.012364 0.014341 0.02855 0.014341 0.060921 L 1 0.907519 c 0 0.032371 0 0.048557 -0.014341 0.060921 a 0.131579 0.057801 0 0 1 -0.057502 0.02526 c -0.028146 0.0063 -0.064992 0.0063 -0.138683 0.0063 L 0.210526 1 c -0.073691 0 -0.110536 0 -0.138683 -0.0063 a 0.131579 0.057801 0 0 1 -0.057502 -0.02526 c -0.014341 -0.012364 -0.014341 -0.02855 -0.014341 -0.060921 L 0 0.092481 c 0 -0.032371 0 -0.048557 0.014341 -0.060921 a 0.131579 0.057801 0 0 1 0.057502 -0.02526 c 0.028146 -0.0063 0.064992 -0.0063 0.138683 -0.0063 Z';

// A neutral, lightly anisotropic metal gradient (titanium catching ambient
// light). Flatten to a solid `#3a3a3f` for a more daisyUI-flat chrome look.
const RAIL_METAL =
    'linear-gradient(135deg,#6a6a70 0%,#34343a 22%,#4c4c52 48%,#232327 72%,#5e5e65 100%)';
const BUTTON_METAL = 'linear-gradient(to left,#2a2a2e,#5c5c63)';

/**
 * The frame's outer aspect ratio (width / height) — an iPhone 14 Pro's
 * 1170x2532, the same box the superellipse paths above were generated for.
 * Exported because callers have to size the frame by HEIGHT (a full-width phone
 * is taller than a phone viewport), and they must not re-guess this number.
 */
export const PHONE_FRAME_ASPECT = 1170 / 2532;

export function PhoneFrame({ children }: PhoneFrameProps) {
    return (
        <div
            className="relative w-full"
            style={{
                aspectRatio: String(PHONE_FRAME_ASPECT),
                filter: 'drop-shadow(0 44px 90px rgba(0,0,0,0.5)) drop-shadow(0 10px 26px rgba(0,0,0,0.32))',
            }}
        >
            {/* Superellipse clip definitions (objectBoundingBox → scale-free). */}
            <svg aria-hidden width="0" height="0" className="absolute">
                <defs>
                    <clipPath id="phoneRailClip" clipPathUnits="objectBoundingBox">
                        <path d={RAIL_CLIP} />
                    </clipPath>
                    <clipPath id="phoneBezelClip" clipPathUnits="objectBoundingBox">
                        <path d={BEZEL_CLIP} />
                    </clipPath>
                    <clipPath id="phoneScreenClip" clipPathUnits="objectBoundingBox">
                        <path d={SCREEN_CLIP} />
                    </clipPath>
                </defs>
            </svg>

            {/* Container-query context: cqw resolves against this width. */}
            <div className="relative h-full w-full [container-type:inline-size]">
                {/* Side buttons — same metal as the rail, tucked behind it. */}
                <div aria-hidden className="absolute left-[-1.1cqw] top-[17.5%] h-[5.5%] w-[1.3cqw] rounded-l-[1.4cqw]" style={{ background: BUTTON_METAL }} />
                <div aria-hidden className="absolute left-[-1.1cqw] top-[25.5%] h-[8.5%] w-[1.3cqw] rounded-l-[1.4cqw]" style={{ background: BUTTON_METAL }} />
                <div aria-hidden className="absolute left-[-1.1cqw] top-[36%] h-[8.5%] w-[1.3cqw] rounded-l-[1.4cqw]" style={{ background: BUTTON_METAL }} />
                <div aria-hidden className="absolute right-[-1.1cqw] top-[30%] h-[12%] w-[1.3cqw] rounded-r-[1.4cqw]" style={{ background: BUTTON_METAL }} />

                {/* Rail: outer polished-metal band. */}
                <div
                    className="relative h-full w-full p-[1.2cqw]"
                    style={{ background: RAIL_METAL, clipPath: 'url(#phoneRailClip)' }}
                >
                    {/* Bezel: solid black band. */}
                    <div
                        className="relative h-full w-full bg-black p-[1.5cqw]"
                        style={{ clipPath: 'url(#phoneBezelClip)' }}
                    >
                        {/* Screen: clips the content to the inner squircle. */}
                        <div
                            className="relative h-full w-full overflow-hidden bg-black"
                            style={{ clipPath: 'url(#phoneScreenClip)' }}
                        >
                            {children}
                            {/* Dynamic Island. */}
                            <div
                                aria-hidden
                                className="pointer-events-none absolute left-1/2 top-[1.5%] h-[3.2%] w-[32%] -translate-x-1/2 rounded-full bg-black"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
