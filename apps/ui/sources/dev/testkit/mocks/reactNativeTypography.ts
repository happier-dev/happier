/** React Native's platform-specific font styles cannot load through Node CJS. */
export function createReactNativeTypographyMock() {
    return {
        iOSUIKit: { title3: {}, title3Object: {} },
        human: {},
        humanDense: {},
        humanTall: {},
        material: {},
        materialDense: {},
        materialTall: {},
    };
}
