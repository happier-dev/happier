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

/** Uploads carry bytes, never a caller-selected path on the browser's Machine. */
export const BrowserUploadFileV1Schema = z.strictObject({
  name: z.string().check(z.minLength(1), z.refine(name => !/[\\/\x00]/u.test(name) && name !== '.' && name !== '..')),
  dataBase64: z.string().check(z.refine(value => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))),
});
export type BrowserUploadFileV1 = z.infer<typeof BrowserUploadFileV1Schema>;
export const BrowserFileChooserInputEventV1Schema = z.strictObject({
  kind: z.literal('fileChooser'), target: BrowserInputTargetV1Schema,
  chooserId: z.string().check(z.minLength(1)), files: z.array(BrowserUploadFileV1Schema),
  sequence: z.number().check(z.int(), z.nonnegative()),
});
export const BrowserDialogInputEventV1Schema = z.strictObject({
  kind: z.literal('dialog'), target: BrowserInputTargetV1Schema,
  dialogId: z.string().check(z.minLength(1)), accept: z.boolean(), promptText: z.optional(z.string()),
  sequence: z.number().check(z.int(), z.nonnegative()),
});
export const BrowserDownloadInputEventV1Schema = z.strictObject({
  kind: z.literal('download'), target: BrowserInputTargetV1Schema, downloadId: z.string().check(z.minLength(1)),
  // The viewer sizes each requested range for its negotiated transport budget.
  offset: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  byteLength: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
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
  z.extend(z.omit(BrowserViewportV1Schema, { emulation: true }), {
    kind: z.literal('viewport'),
    target: BrowserInputTargetV1Schema,
    sequence: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({
    kind: z.literal('editableProbe'),
    target: BrowserInputTargetV1Schema,
    x: z.number().check(z.minimum(0), z.maximum(1)),
    y: z.number().check(z.minimum(0), z.maximum(1)),
    sequence: z.number().check(z.int(), z.nonnegative()),
  }),
]);
export type BrowserInputEventV1 = z.infer<typeof BrowserInputEventV1Schema>;

/** Human-only state uses sealed live-view metadata, never telemetry or the agent timeline. */
export const BrowserInteractionStateV1Schema = z.strictObject({
  unavailable: z.optional(z.strictObject({
    download: z.optional(z.literal('runtime_unavailable')),
    fileChooser: z.optional(z.literal('runtime_unavailable')),
  })),
  dialog: z.nullable(z.strictObject({ dialogId: z.string(), type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
    message: z.string(), defaultPrompt: z.optional(z.string()) })),
  fileChooser: z.nullable(z.strictObject({ chooserId: z.string(), multiple: z.boolean() })),
  downloads: z.array(z.strictObject({ downloadId: z.string(), name: z.string(),
    state: z.enum(['inProgress', 'completed', 'canceled']), receivedBytes: z.number().check(z.nonnegative()),
    totalBytes: z.number().check(z.nonnegative()) })),
});
export type BrowserInteractionStateV1 = z.infer<typeof BrowserInteractionStateV1Schema>;

/** Keyboard hints only. Field values, names and labels never cross this boundary. */
export const BrowserEditableTargetV1Schema = z.discriminatedUnion('editable', [
  z.strictObject({ editable: z.literal(false) }),
  z.strictObject({
    editable: z.literal(true),
    inputMode: z.enum(['text', 'none', 'tel', 'url', 'email', 'numeric', 'decimal', 'search']),
    multiline: z.boolean(),
    secret: z.boolean(),
  }),
]);
export type BrowserEditableTargetV1 = z.infer<typeof BrowserEditableTargetV1Schema>;
