export type TextModuleMockOptions = Readonly<{
    translate?: (key: string, params?: Record<string, unknown>) => unknown;
    translateLoose?: (key: string, params?: Record<string, unknown>) => unknown;
    getPreferredLanguage?: () => string;
}>;

export function createTextModuleMock(options: TextModuleMockOptions = {}) {
    const translate = options.translate ?? ((key: string, params?: Record<string, unknown>) => (
        params ? { key, params } : key
    ));
    const translateLoose = options.translateLoose ?? translate;
    const getPreferredLanguage = options.getPreferredLanguage ?? (() => 'en');

    return {
        t: translate,
        tLoose: translateLoose,
        getPreferredLanguage,
    };
}

export function installTextModuleMock(options: TextModuleMockOptions = {}) {
    return () => createTextModuleMock(options);
}
