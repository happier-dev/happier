export type TextModuleRuntimeOptions = Readonly<{
    translate?: (key: string, params?: Record<string, unknown>) => unknown;
    translateLoose?: (key: string, params?: Record<string, unknown>) => unknown;
    getPreferredLanguage?: () => string;
    /**
     * Catalog membership, which `tLoose` consumers check before treating a
     * loose key as a real translation. Defaults to "no catalog", so a mocked
     * surface falls back to its developer-supplied literal instead of rendering
     * the key itself.
     */
    hasTranslation?: (key: string) => boolean;
}>;

/**
 * The real `t` (sources/text/i18n.ts) always returns a `string`. A default mock that returned
 * `{ key, params }` for the parameterized call therefore had a shape the production API can never
 * produce, and any component rendering `t(key, params)` as a React child crashed under it with
 * "Objects are not valid as a React child" — a test failure caused purely by the mock.
 *
 * The serialized form below is the convention suites already assert, e.g.
 * `'agentInput.acp.optionOverriddenBy(name=Ultracode)'`.
 */
function formatMockTranslation(key: string, params?: Record<string, unknown>): string {
    if (!params) return key;
    const serializedParams = Object.entries(params)
        .map(([paramName, paramValue]) => `${paramName}=${String(paramValue)}`)
        .join(',');
    return `${key}(${serializedParams})`;
}

export function createTextModuleRuntime(options: TextModuleRuntimeOptions = {}) {
    const translate = options.translate ?? formatMockTranslation;
    const translateLoose = options.translateLoose ?? translate;
    const getPreferredLanguage = options.getPreferredLanguage ?? (() => 'en');
    const hasTranslation = options.hasTranslation ?? (() => false);

    return {
        t: translate,
        tLoose: translateLoose,
        getPreferredLanguage,
        hasTranslation,
    };
}

export function installTextModuleRuntime(options: TextModuleRuntimeOptions = {}) {
    return () => createTextModuleRuntime(options);
}
