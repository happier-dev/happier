import { z } from 'zod/mini';

export const BrowserInputTargetV1Schema = z.literal('page');
export type BrowserInputTargetV1 = z.infer<typeof BrowserInputTargetV1Schema>;

export const BrowserInputModifierV1Schema = z.enum(['alt', 'control', 'meta', 'shift']);
export type BrowserInputModifierV1 = z.infer<typeof BrowserInputModifierV1Schema>;

export const BrowserKeyInputEventV1Schema = z.strictObject({
    kind: z.literal('key'),
    target: BrowserInputTargetV1Schema,
    key: z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
    modifiers: z._default(z.array(BrowserInputModifierV1Schema), []),
    sequence: z.number().check(z.int(), z.nonnegative()),
  });

export const BrowserPointerInputEventV1Schema = z.strictObject({
    kind: z.literal('pointer'),
    target: BrowserInputTargetV1Schema,
    action: z.enum(['down', 'move', 'up', 'cancel']),
    x: z.number().check(z.minimum(0), z.maximum(1)),
    y: z.number().check(z.minimum(0), z.maximum(1)),
    sequence: z.number().check(z.int(), z.nonnegative()),
  });

export const BrowserTextInputEventV1Schema = z.strictObject({
    kind: z.literal('text'),
    target: BrowserInputTargetV1Schema,
    text: z.string().check(z.minLength(1), z.maxLength(16 * 1024)),
    sequence: z.number().check(z.int(), z.nonnegative()),
  });

export const BrowserViewportPresetIdV1Schema = z.enum(['phone', 'smallPhone', 'tablet', 'laptop', 'desktop']);
export type BrowserViewportPresetIdV1 = z.infer<typeof BrowserViewportPresetIdV1Schema>;

/** Chrome emulation profiles, not certification of another engine or physical device.
 * Mobile metrics: https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json
 * Laptop: https://support.apple.com/en-us/111991 (2560×1600 panel; policy uses 2×, full-screen CSS viewport).
 * Desktop: https://www.dell.com/en-uk/shop/dell-24-monitor-p2422h/apd/210-azyx/ (1920×1080 panel; policy uses 1×).
 */
export const BROWSER_VIEWPORT_PRESETS = {
  phone: { deviceName: 'Pixel 7', width: 412, height: 839, deviceScaleFactor: 2.625, mobile: true, touch: true, model: 'Pixel 7', androidVersion: '14.0.0', mobileUserAgent: true },
  smallPhone: { deviceName: 'Galaxy S5', width: 360, height: 640, deviceScaleFactor: 3, mobile: true, touch: true, model: 'SM-G900P', androidVersion: '5.0.0', mobileUserAgent: true },
  tablet: { deviceName: 'Galaxy Tab S4', width: 712, height: 1138, deviceScaleFactor: 2.25, mobile: true, touch: true, model: 'SM-T837A', androidVersion: '8.1.0', mobileUserAgent: false },
  laptop: { deviceName: 'MacBook Air 13-inch', width: 1280, height: 800, deviceScaleFactor: 2, mobile: false, touch: false },
  desktop: { deviceName: 'Full HD display', width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
} as const satisfies Record<BrowserViewportPresetIdV1, Readonly<{
  deviceName: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean;
  model?: string; androidVersion?: string; mobileUserAgent?: boolean;
}>>;

export const BrowserViewportEmulationV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fitViewer') }),
  z.strictObject({ kind: z.literal('preset'), presetId: BrowserViewportPresetIdV1Schema }),
]);
export type BrowserViewportEmulationV1 = z.infer<typeof BrowserViewportEmulationV1Schema>;

export const BrowserViewportV1Schema = z.strictObject({
  width: z.number().check(z.int(), z.positive()),
  height: z.number().check(z.int(), z.positive()),
  deviceScaleFactor: z.number().check(z.positive()),
  emulation: z.optional(BrowserViewportEmulationV1Schema),
});
export type BrowserViewportV1 = z.infer<typeof BrowserViewportV1Schema>;

export const BrowserInputEventV1Schema = z.discriminatedUnion('kind', [
  BrowserKeyInputEventV1Schema,
  BrowserPointerInputEventV1Schema,
  BrowserTextInputEventV1Schema,
]);
export type BrowserInputEventV1 = z.infer<typeof BrowserInputEventV1Schema>;
