import type { ITerminalOptions } from '@xterm/xterm';

/** Preserve authored ANSI and truecolor colors, including bold styling. */
export const XTERM_READABILITY_OPTIONS = Object.freeze({
    minimumContrastRatio: 1,
    drawBoldTextInBrightColors: false,
    fontWeightBold: 'bold',
} satisfies Pick<ITerminalOptions, 'minimumContrastRatio' | 'drawBoldTextInBrightColors' | 'fontWeightBold'>);
