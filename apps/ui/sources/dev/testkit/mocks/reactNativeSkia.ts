/** Skia renderer/native handles cannot be loaded in the Node test process. */
export function createReactNativeSkiaMock() {
    return {
        Canvas: 'Canvas', Circle: 'Circle', Image: 'SkiaImage', Rect: 'Rect', Group: 'Group',
        LinearGradient: 'LinearGradient', RadialGradient: 'RadialGradient', Path: 'Path',
        RoundedRect: 'RoundedRect', DiffRect: 'DiffRect', Picture: 'Picture',
        // A recorded picture is opaque native state; the stub records nothing.
        createPicture: () => ({}),
        Skia: {
            Path: { Make: () => ({ addRect: () => undefined, addRRect: () => undefined }) },
            XYWHRect: () => ({}), RRectXY: () => ({}),
        },
        FilterMode: { Nearest: 'nearest', Linear: 'linear' },
        MipmapMode: { None: 'none', Nearest: 'nearest', Linear: 'linear' },
        rect: () => ({}), rrect: () => ({}),
        useImage: (source: unknown) => source == null ? null : `skia-image:${String(source)}`,
        vec: (x: number, y: number) => ({ x, y }),
    };
}
