/**
 * GENERATED FILE CONTRACT (PS-04)
 *
 * Provider logo resolvers are consumed by generated bundled UI projections.
 * Provider-specific logo data is isolated from generic registry owners here so
 * provider-neutral host files do not hand-author provider-keyed behavior maps.
 */

import type { AgentIconSvgXmlResolver } from './registryUi';
import type { CanonicalAgentId } from './registryCore';
import type { Theme } from '@/theme';

function svg(xml: string): string {
    return xml.replace(/\s{2,}/g, ' ').trim();
}

function themedSvg(body: string, viewBox: string): string {
    return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`);
}

function monochrome(color: string, body: string, viewBox: string): string {
    return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${color}">${body}</svg>`);
}

function qwenSvg(theme: Theme): string {
    // Official Qwen logo (mark only), rendered in two monochrome tones.
    const primary = theme.colors.text.primary;
    return themedSvg(
        `
            <!-- Use even-odd fill so the interior path becomes a true cutout (transparent holes). -->
            <path fill="${primary}" fill-rule="evenodd" clip-rule="evenodd" d="M174.82 108.75L155.38 75L165.64 57.75C166.46 56.31 166.46 54.53 165.64 53.09L155.38 35.84C154.86 34.91 153.87 34.33 152.78 34.33H114.88L106.14 19.03C105.62 18.1 104.63 17.52 103.54 17.52H83.3C82.21 17.52 81.22 18.1 80.7 19.03L61.26 52.77H41.02C39.93 52.77 38.94 53.35 38.42 54.28L28.16 71.53C27.34 72.97 27.34 74.75 28.16 76.19L45.52 107.5L36.78 122.8C35.96 124.24 35.96 126.02 36.78 127.46L47.04 144.71C47.56 145.64 48.55 146.22 49.64 146.22H87.54L96.28 161.52C96.8 162.45 97.79 163.03 98.88 163.03H119.12C120.21 163.03 121.2 162.45 121.72 161.52L141.16 127.78H158.52C159.61 127.78 160.6 127.2 161.12 126.27L171.38 109.02C172.2 107.58 172.2 105.8 171.38 104.36L174.82 108.75Z M119.12 163.03H98.88L87.54 144.71H49.64L61.26 126.39H80.7L38.42 55.29H61.26L83.3 19.03L93.56 37.35L83.3 55.29H161.58L151.32 72.54L170.76 106.28H151.32L141.16 88.34L101.18 163.03H119.12Z"/>
            <path fill="${primary}" d="M127.86 79.83H76.14L101.18 122.11L127.86 79.83Z"/>
        `,
        // Crop the official 200x200 viewBox to reduce built-in padding so it scales better at 12px.
        '28 17.52 147 147',
    );
}

function antigravitySvg(_theme: Theme): string {
    return svg(`
        <svg width="16" height="15" viewBox="0 0 16 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <mask id="antigravity__mask0_111_52" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="15">
                <path d="M14.0777 13.984C14.945 14.6345 16.2458 14.2008 15.0533 13.0084C11.476 9.53949 12.2349 0 7.79033 0C3.34579 0 4.10461 9.53949 0.527295 13.0084C-0.773543 14.3092 0.635692 14.6345 1.50293 13.984C4.86344 11.7076 4.64663 7.69664 7.79033 7.69664C10.934 7.69664 10.7172 11.7076 14.0777 13.984Z" fill="black"/>
            </mask>
            <g mask="url(#antigravity__mask0_111_52)">
                <g filter="url(#antigravity__filter0_f_111_52)"><path d="M-0.658907 -3.2306C-0.922679 -0.906781 1.07986 1.22861 3.81388 1.53894C6.54791 1.84927 8.97811 0.217009 9.24188 -2.10681C9.50565 -4.43063 7.50312 -6.56602 4.76909 -6.87635C2.03506 -7.18667 -0.395135 -5.55442 -0.658907 -3.2306Z" fill="#FFE432"/></g>
                <g filter="url(#antigravity__filter1_f_111_52)"><path d="M9.88233 4.36642C10.5673 7.31568 13.566 9.13902 16.5801 8.43896C19.5942 7.73891 21.4823 4.78056 20.7973 1.83131C20.1123 -1.11795 17.1136 -2.94128 14.0995 -2.24123C11.0854 -1.54118 9.19733 1.41717 9.88233 4.36642Z" fill="#FC413D"/></g>
                <g filter="url(#antigravity__filter2_f_111_52)"><path d="M-8.05291 6.34512C-7.18736 9.38883 -3.28925 10.9473 0.653774 9.82598C4.5968 8.7047 7.09158 5.32829 6.22603 2.28458C5.36048 -0.759142 1.46236 -2.31758 -2.48066 -1.19629C-6.42368 -0.0750048 -8.91846 3.3014 -8.05291 6.34512Z" fill="#00B95C"/></g>
                <g filter="url(#antigravity__filter3_f_111_52)"><path d="M-8.05291 6.34512C-7.18736 9.38883 -3.28925 10.9473 0.653774 9.82598C4.5968 8.7047 7.09158 5.32829 6.22603 2.28458C5.36048 -0.759142 1.46236 -2.31758 -2.48066 -1.19629C-6.42368 -0.0750048 -8.91846 3.3014 -8.05291 6.34512Z" fill="#00B95C"/></g>
                <g filter="url(#antigravity__filter4_f_111_52)"><path d="M-4.92402 8.86746C-2.75421 11.0837 0.982691 10.9438 3.42257 8.55507C5.86246 6.1663 6.08139 2.43321 3.91158 0.216963C1.74177 -1.99928 -1.99513 -1.85942 -4.43501 0.529349C-6.87489 2.91812 -7.09383 6.65122 -4.92402 8.86746Z" fill="#00B95C"/></g>
                <g filter="url(#antigravity__filter5_f_111_52)"><path d="M6.42819 17.2263C7.10197 20.1273 9.91278 21.953 12.7063 21.3042C15.4998 20.6553 17.2182 17.7777 16.5444 14.8767C15.8707 11.9757 13.0599 10.15 10.2663 10.7988C7.47281 11.4477 5.75441 14.3253 6.42819 17.2263Z" fill="#3186FF"/></g>
                <g filter="url(#antigravity__filter6_f_111_52)"><path d="M1.66508 -5.94539C0.254213 -2.80254 1.7978 0.951609 5.11277 2.43973C8.42774 3.92785 12.2588 2.58642 13.6696 -0.556431C15.0805 -3.69928 13.5369 -7.45343 10.222 -8.94155C6.90699 -10.4297 3.07594 -9.08824 1.66508 -5.94539Z" fill="#FBBC04"/></g>
                <g filter="url(#antigravity__filter7_f_111_52)"><path d="M-2.11428 24.3903C-5.52984 23.0496 0.307266 12.0177 1.75874 8.32038C3.21024 4.62304 7.15576 2.71272 10.5713 4.05357C13.9869 5.39442 18.0354 12.7796 16.5838 16.477C15.1323 20.1743 1.30129 25.7311 -2.11428 24.3903Z" fill="#3186FF"/></g>
                <g filter="url(#antigravity__filter8_f_111_52)"><path d="M18.5814 10.6598C17.6669 11.727 15.2806 11.1828 13.2514 9.44417C11.2222 7.70556 10.3185 5.43097 11.2329 4.3637C12.1473 3.29646 14.5336 3.84069 16.5628 5.57928C18.592 7.31789 19.4958 9.59249 18.5814 10.6598Z" fill="#749BFF"/></g>
                <g filter="url(#antigravity__filter9_f_111_52)"><path d="M11.7552 5.22715C15.5162 7.77124 19.8471 7.93838 21.4286 5.60045C23.0101 3.26253 21.2433 -0.695128 17.4823 -3.23922C13.7213 -5.78331 9.39044 -5.95044 7.80896 -3.61252C6.22747 -1.27459 7.99428 2.68306 11.7552 5.22715Z" fill="#FC413D"/></g>
                <g filter="url(#antigravity__filter10_f_111_52)"><path d="M-0.592149 1.08896C-1.5239 3.33663 -1.21959 5.59799 0.0875457 6.13985C1.39468 6.68171 3.20966 5.29888 4.14141 3.05121C5.07316 0.803541 4.76885 -1.45782 3.46171 -1.99968C2.15458 -2.54154 0.339602 -1.15871 -0.592149 1.08896Z" fill="#FFEE48"/></g>
            </g>
            <defs>
                <filter id="antigravity__filter0_f_111_52" x="-2.12817" y="-8.35998" width="12.8393" height="11.383" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="0.722959" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter1_f_111_52" x="2.75168" y="-9.38089" width="25.1763" height="24.96" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="3.49513" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter2_f_111_52" x="-14.1669" y="-7.50196" width="26.5068" height="23.6338" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.97119" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter3_f_111_52" x="-14.1669" y="-7.50196" width="26.5068" height="23.6338" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.97119" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter4_f_111_52" x="-12.3607" y="-7.29981" width="23.709" height="23.6846" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.97119" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter5_f_111_52" x="0.634962" y="5.02095" width="21.7027" height="22.0616" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.82351" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter6_f_111_52" x="-3.97547" y="-14.6666" width="23.2857" height="22.8313" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.5589" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter7_f_111_52" x="-7.7407" y="-0.945408" width="29.1982" height="30.1105" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.2852" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter8_f_111_52" x="6.78641" y="-0.27231" width="16.2415" height="15.5681" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.04485" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter9_f_111_52" x="3.77526" y="-8.71693" width="21.687" height="19.4212" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="1.72712" result="effect1_foregroundBlur_111_52"/></filter>
                <filter id="antigravity__filter10_f_111_52" x="-5.40727" y="-6.39238" width="14.3639" height="16.9254" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.1376" result="effect1_foregroundBlur_111_52"/></filter>
            </defs>
        </svg>
    `);
}

function claudeSvg(theme: Theme): string {
    // Extracted from the official Claude logo SVG. (Logomark only, no wordmark.)
    // Source SVG contains a translate transform; we keep it to preserve exact geometry.
    return monochrome(
        theme.colors.text.primary,
        `<g transform="translate(-75.96 -223.53)"><path d="m 105.01,322.07 29.14,-16.35 0.49,-1.42 -0.49,-0.79 h -1.42 l -4.87,-0.3 -16.65,-0.45 -14.44,-0.6 -13.99,-0.75 -3.52,-0.75 -3.3,-4.35 0.34,-2.17 2.96,-1.99 4.24,0.37 9.37,0.64 14.06,0.97 10.2,0.6 15.11,1.57 h 2.4 l 0.34,-0.97 -0.82,-0.6 -0.64,-0.6 -14.55,-9.86 -15.75,-10.42 -8.25,-6 -4.46,-3.04 -2.25,-2.85 -0.97,-6.22 4.05,-4.46 5.44,0.37 1.39,0.37 5.51,4.24 11.77,9.11 15.37,11.32 2.25,1.87 0.9,-0.64 0.11,-0.45 -1.01,-1.69 -8.36,-15.11 -8.92,-15.37 -3.97,-6.37 -1.05,-3.82 c -0.37,-1.57 -0.64,-2.89 -0.64,-4.5 l 4.61,-6.26 2.55,-0.82 6.15,0.82 2.59,2.25 3.82,8.74 6.19,13.76 9.6,18.71 2.81,5.55 1.5,5.14 0.56,1.57 h 0.97 v -0.9 l 0.79,-10.54 1.46,-12.94 1.42,-16.65 0.49,-4.69 2.32,-5.62 4.61,-3.04 3.6,1.72 2.96,4.24 -0.41,2.74 -1.76,11.44 -3.45,17.92 -2.25,12 h 1.31 l 1.5,-1.5 6.07,-8.06 10.2,-12.75 4.5,-5.06 5.25,-5.59 3.37,-2.66 h 6.37 l 4.69,6.97 -2.1,7.2 -6.56,8.32 -5.44,7.05 -7.8,10.5 -4.87,8.4 0.45,0.67 1.16,-0.11 17.62,-3.75 9.52,-1.72 11.36,-1.95 5.14,2.4 0.56,2.44 -2.02,4.99 -12.15,3 -14.25,2.85 -21.22,5.02 -0.26,0.19 0.3,0.37 9.56,0.9 4.09,0.22 h 10.01 l 18.64,1.39 4.87,3.22 2.92,3.94 -0.49,3 -7.5,3.82 -10.12,-2.4 -23.62,-5.62 -8.1,-2.02 h -1.12 v 0.67 l 6.75,6.6 12.37,11.17 15.49,14.4 0.79,3.56 -1.99,2.81 -2.1,-0.3 -13.61,-10.24 -5.25,-4.61 -11.89,-10.01 h -0.79 v 1.05 l 2.74,4.01 14.47,21.75 0.75,6.67 -1.05,2.17 -3.75,1.31 -4.12,-0.75 -8.47,-11.89 -8.74,-13.39 -7.05,-12 -0.86,0.49 -4.16,44.81 -1.95,2.29 -4.5,1.72 -3.75,-2.85 -1.99,-4.61 1.99,-9.11 2.4,-11.89 1.95,-9.45 1.76,-11.74 1.05,-3.9 -0.07,-0.26 -0.86,0.11 -8.85,12.15 -13.46,18.19 -10.65,11.4 -2.55,1.01 -4.42,-2.29 0.41,-4.09 2.47,-3.64 14.74,-18.75 8.89,-11.62 5.74,-6.71 -0.04,-0.97 h -0.34 l -39.15,25.42 -6.97,0.9 -3,-2.81 0.37,-4.61 1.42,-1.5 11.77,-8.1 -0.04,0.04 z\"/></g>`,
        // Square viewBox to keep the mark visually centered at small sizes.
        '-0.045 0 148.18 148.18',
    );
}

function geminiSvg(theme: Theme): string {
    // Google Gemini icon path (star only). We render it monochrome to match the app theme.
    return monochrome(
        theme.colors.text.primary,
        `<path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 0 0 1.999 5.905c2.152 5 5.105 9.376 8.854 13.125c3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 0 0 5.906 1.999c.66.166 1.124.758 1.124 1.438c0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 0 0-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854c-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 0 0-2 5.906a1.485 1.485 0 0 1-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 0 0-2-5.905c-2.151-5-5.103-9.375-8.854-13.125c-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 0 0-5.905-2A1.485 1.485 0 0 1 0 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 0 0 5.905-2c5-2.151 9.376-5.104 13.125-8.854c3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 0 0 1.999-5.905A1.485 1.485 0 0 1 32.447 0z"/>`,
        '0 0 65 65',
    );
}

function codexSvg(theme: Theme): string {
    // OpenAI Blossom (used for Codex/OpenAI). Mark-only, rendered monochrome.
    return monochrome(
        theme.colors.text.primary,
        `<path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"/>`,
        // Square viewBox (geometry in the official file is 146.694..413.892 x 227.042..491.854).
        '146.694 225.849 267.198 267.198',
    );
}

function kiloSvg(theme: Theme): string {
    // Kilo mark-only logo (no background tile).
    return monochrome(
        theme.colors.text.primary,
        `
            <path d="M23,26v-2h3v-5l-2-2h-4v2h-3v5l2,2h4ZM20,20h3v3h-3v-3Z"/>
            <rect x="12" y="17" width="3" height="3"/>
            <polygon points="26 12 23 12 23 9 20 6 17 6 17 9 20 9 20 12 17 12 17 15 26 15 26 12"/>
            <path d="M0,0v32h32V0H0ZM29,29H3V3h26v26Z"/>
            <polygon points="15 26 15 23 9 23 9 17 6 17 6 23.1875 8.8125 26 15 26"/>
            <rect x="12" y="6" width="3" height="3"/>
            <polygon points="9 12 12 12 12 15 15 15 15 12 12 9 9 9 9 6 6 6 6 15 9 15 9 12"/>
        `,
        '0 0 32 32',
    );
}

function kiroSvg(theme: Theme): string {
    // Mark-only Kiro silhouette (no background tile), preserving the eye cutouts via evenodd fill.
    return monochrome(
        theme.colors.text.primary,
        `<path fill-rule="evenodd" d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z"/>`,
        // Cropped square viewBox to make the mark visually consistent with other provider icons.
        '146.994 128.946 930.714 930.714',
    );
}

function piSvg(theme: Theme): string {
    return monochrome(
        theme.colors.text.primary,
        `
            <path fill-rule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"/>
            <path d="M517.36 400H634.72V634.72H517.36Z"/>
        `,
        // Crop to the actual mark bounds so it doesn't render tiny in small pickers.
        '165.29 165.29 469.43 469.43',
    );
}

function ohMyPiSvg(theme: Theme): string {
    // Source: https://github.com/can1357/oh-my-pi/blob/main/assets/icon.svg
    // Keep the upstream geometry, but map fills to the app theme like the other provider marks.
    const primary = theme.colors.text.primary;
    const accent = theme.colors.accent.orange;
    const cutout = theme.colors.surface.base;
    return themedSvg(
        `
            <title>oh-my-pi-logo</title>
            <rect x="10" y="8" width="100" height="12" rx="2" fill="${primary}"/>
            <rect x="25" y="20" width="12" height="62" rx="2" fill="${primary}"/>
            <rect x="75" y="20" width="12" height="45" rx="2" fill="${primary}"/>
            <rect x="71" y="55" width="20" height="16" rx="3" fill="${accent}"/>
            <rect x="76" y="59" width="3" height="8" rx="1" fill="${cutout}"/>
            <rect x="82" y="59" width="3" height="8" rx="1" fill="${cutout}"/>
            <circle cx="18" cy="14" r="2" fill="${accent}" opacity="0.8"/>
            <circle cx="102" cy="14" r="2" fill="${accent}" opacity="0.8"/>
        `,
        '0 0 120 90',
    );
}

function copilotSvg(theme: Theme): string {
    return monochrome(
        theme.colors.text.primary,
        `
            <path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z"/>
            <path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"/>
        `,
        '0 0 16 16',
    );
}

function kimiSvg(theme: Theme): string {
    // KIMI "K only" mark. Rendered as a monochrome icon.
    return monochrome(
        theme.colors.text.primary,
        `
            <path d="M21.7202 0.939941C22.9502 0.939941 23.9502 1.93994 23.9502 3.16994C23.9502 4.39994 22.9502 5.39994 21.7202 5.39994H19.7502C19.6002 5.39994 19.4902 5.27994 19.4902 5.13994V3.16994C19.4902 1.93994 20.4902 0.939941 21.7202 0.939941Z"/>
            <path d="M9.39 13.9501L17.82 5.59012C17.98 5.43012 17.89 5.12012 17.68 5.12012H13.14C13.14 5.12012 13.04 5.14012 13 5.18012L3.92 14.1901C3.78 14.3301 3.57 14.2101 3.57 13.9801V5.39012C3.57 5.24012 3.47 5.12012 3.35 5.12012H0.219999C0.0999993 5.12012 0 5.24012 0 5.39012V23.9201C0 24.0701 0.0999993 24.1901 0.219999 24.1901H3.35C3.47 24.1901 3.57 24.0701 3.57 23.9201V20.1401C3.57 20.0601 3.6 19.9801 3.65 19.9301L6.47 17.1401C6.54 17.0701 6.63 17.0601 6.71 17.1101L14.24 22.6501C15.47 23.4801 16.85 23.9901 18.25 24.1401C18.37 24.1501 18.48 24.0301 18.48 23.8701V20.3101C18.48 20.1701 18.4 20.0601 18.29 20.0501C17.47 19.9201 16.66 19.6001 15.94 19.1101L9.42 14.3901C9.28 14.3001 9.27 14.0701 9.39 13.9501Z"/>
        `,
        // Square viewBox to avoid baseline jitter.
        '0 0 25 25',
    );
}

function auggieSvg(theme: Theme): string {
    return monochrome(
        theme.colors.text.primary,
        `
            <path d="M78.844 464.762c-8.453 0-15.573-1.451-21.359-4.339-5.77-2.888-10.144-7.289-13.076-13.095-2.932-5.807-4.436-12.912-4.436-21.255v-86.028c0-10.605-2.125-18.321-6.329-23.135-4.234-4.798-11.742-7.334-22.507-7.579-3.35 0-6.034-1.253-8.066-3.804C1.008 303.005 0 300.087 0 296.832c0-3.53 1.008-6.448 3.071-8.725 2.048-2.277 4.762-3.53 8.066-3.774 10.765-.26 18.273-2.781 22.507-7.579 4.235-4.798 6.329-12.392 6.329-22.752v-86.028c0-12.637 3.35-22.249 10.005-28.804 6.654-6.555 16.287-9.856 28.866-9.856H181.5c3.862 0 7.042 1.146 9.617 3.408 2.559 2.277 3.862 5.195 3.862 8.694 0 3.301-1.086 6.128-3.257 8.542-2.172 2.414-5.057 3.622-8.671 3.622H87.732c-5.413 0-9.508 1.39-12.316 4.171-2.823 2.781-4.234 7.075-4.234 12.912v86.425c0 7.579-1.551 14.455-4.623 20.644-3.07 6.204-7.181 11.063-12.316 14.623-5.134 3.53-11.137 5.302-18.07 5.302v-1.528c6.933 0 12.936 1.773 18.07 5.303 5.135 3.529 9.245 8.404 12.316 14.623 3.072 6.188 4.623 13.064 4.623 20.643v86.808c0 5.837 1.411 10.115 4.234 12.911 2.823 2.812 6.934 4.172 12.316 4.172h95.318c3.583 0 6.468 1.207 8.671 3.606 2.202 2.414 3.257 5.257 3.257 8.542s-1.272 6.097-3.862 8.511c-2.575 2.414-5.771 3.606-9.617 3.606H78.844v-.092Z"/>
            <path d="M330.501 464.768c-3.862 0-7.042-1.207-9.617-3.606-2.575-2.414-3.863-5.256-3.863-8.511 0-3.255 1.086-6.128 3.258-8.542 2.171-2.414 5.057-3.606 8.671-3.606h95.317c5.414 0 9.509-1.36 12.316-4.171 2.823-2.781 4.235-7.075 4.235-12.912v-86.808c0-7.579 1.551-14.455 4.622-20.643 3.071-6.204 7.182-11.063 12.316-14.623 5.134-3.53 11.137-5.303 18.071-5.303v1.528c-6.934 0-12.937-1.772-18.071-5.302-5.134-3.53-9.245-8.404-12.316-14.623-3.071-6.189-4.622-13.065-4.622-20.644v-86.425c0-5.807-1.412-10.1-4.235-12.912-2.823-2.781-6.933-4.171-12.316-4.171H328.95c-3.583 0-6.469-1.208-8.671-3.622-2.172-2.384-3.258-5.241-3.258-8.542 0-3.529 1.272-6.417 3.863-8.694 2.559-2.277 5.755-3.407 9.617-3.407h102.654c12.58 0 22.181 3.3 28.867 9.855 6.685 6.556 10.005 16.167 10.005 28.804v86.028c0 10.36 2.125 17.969 6.328 22.752 4.235 4.798 11.742 7.334 22.507 7.579 3.351.244 6.034 1.497 8.066 3.774 2.063 2.277 3.071 5.195 3.071 8.725 0 3.301-1.008 6.189-3.071 8.695-2.032 2.521-4.762 3.804-8.066 3.804-10.765.245-18.257 2.781-22.507 7.579-4.234 4.798-6.328 12.5-6.328 23.135v86.028c0 8.358-1.474 15.418-4.437 21.255-2.962 5.837-7.305 10.176-13.076 13.095-5.785 2.888-12.905 4.339-21.359 4.339H330.501v.092Z"/>
            <path d="M356.885 329.738c18.691 0 33.846-14.929 33.846-33.342 0-18.412-15.155-33.341-33.846-33.341-18.691 0-33.846 14.929-33.846 33.341 0 18.413 15.155 33.342 33.846 33.342ZM167.305 329.738c18.691 0 33.846-14.929 33.846-33.342 0-18.412-15.155-33.341-33.846-33.341-18.691 0-33.846 14.929-33.846 33.341 0 18.413 15.155 33.342 33.846 33.342ZM244.477 32.846l-2.59 68.135c0 3.82-3.661 5.73-10.983 5.73-7.321 0-10.982-1.91-10.982-5.73-.651-16.976-1.178-30.148-1.613-39.484-.217-9.55-.434-16.35-.651-20.384-.217-4.034-.326-6.479-.326-7.32v-1.268c0-4.874 4.529-7.319 13.572-7.319 9.044 0 13.573 2.552 13.573 7.64Zm54.941 0-2.59 68.135c0 3.82-3.661 5.73-10.982 5.73-7.322 0-10.982-1.91-10.982-5.73-.652-16.976-1.179-30.148-1.613-39.484-.218-9.55-.435-16.35-.652-20.384-.217-4.034-.326-6.479-.326-7.32v-1.268c0-4.874 4.53-7.319 13.573-7.319s13.572 2.552 13.572 7.64Z"/>
        `,
        '0 0 512 512',
    );
}

function cursorSvg(theme: Theme): string {
    const primary = theme.colors.text.primary;
    return themedSvg(
        `
            <rect x="3" y="5" width="26" height="22" rx="5" fill="none" stroke="${primary}" stroke-width="3"/>
            <path d="M9 12L14 16L9 20" fill="none" stroke="${primary}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M17 21H23" fill="none" stroke="${primary}" stroke-width="3" stroke-linecap="round"/>
        `,
        '0 0 32 32',
    );
}

const AGENT_LOGO_SVG_XML_ENTRIES: readonly (readonly [CanonicalAgentId, AgentIconSvgXmlResolver])[] = [
    ['antigravity', antigravitySvg],
    ['auggie', auggieSvg],
    ['claude', claudeSvg],
    ['copilot', copilotSvg],
    ['codex', codexSvg],
    ['cursor', cursorSvg],
    ['gemini', geminiSvg],
    ['kimi', kimiSvg],
    ['kilo', kiloSvg],
    ['kiro', kiroSvg],
    ['ohMyPi', ohMyPiSvg],
    ['pi', piSvg],
    ['qwen', qwenSvg],
];

export const AGENT_LOGO_SVG_XML: Partial<Record<CanonicalAgentId, AgentIconSvgXmlResolver>> = Object.freeze(
    Object.fromEntries(AGENT_LOGO_SVG_XML_ENTRIES),
);
