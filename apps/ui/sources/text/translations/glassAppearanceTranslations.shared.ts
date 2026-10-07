type LocaleCopyShape<T> = T extends string ? string : T extends (...args: infer Args) => infer Result ? (...args: Args) => Result : T extends object ? { [Key in keyof T]: LocaleCopyShape<T[Key]> } : T;
declare const effectiveTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", LocaleCopyShape<typeof effectiveTranslationsEnglish.en>>;


export const effectiveTranslationsEnglish = { "en": {
        "effectiveBrowserSolid": "Solid menus and floating controls. A browser can’t show your desktop.",
        "effectiveFloatingSolid": "Solid floating controls on this device.",
        "effectiveSolid": "Solid surfaces on this device.",
        "effectiveBrowser": "Glass on menus and floating controls. A browser can’t show your desktop.",
        "effectiveBrowserCustom": "Your material on menus and floating controls. A browser can’t show your desktop.",
        "effectivePhone": "Glass on floating controls and sheets.",
        "effectiveLayered": "Glass across this window, layered.",
        "effectiveUniform": "Glass across this window, with one uniform coat.",
        "effectiveCustom": "Glass across this window, as you customized it.",
        "effectiveUnavailable": "Window glass is unavailable here. Floating controls still use your chosen material.",
        "effectiveInactive": "Solid while this window is inactive.",
        "effectiveTint": "Tinted floating controls on this device; background blur is unavailable.",
        "description": "Let your desktop show through the window, and the page through floating controls.",
        "descriptionBrowser": "Let the page show through menus and floating controls.",
        "descriptionPhone": "Let the page show through floating controls and sheets.",
        "chromeDescription": "Title strip, app rail and window background",
        "sidebarDescription": "Your sessions column",
        "contentDescription": "Transcript, composer and working panes",
        "floatingDescription": "Menus, popovers, sheets and floating controls",
        "clear": "Clear",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-click · ${modifier}⇧L to switch light and dark`
    } } as const;



export const englishTranslations = { iosReduceTransparencyPath: "Settings › Accessibility › Display & Text Size › Reduce Transparency", title: 'Glass', material: 'Material', solid: 'Solid', auto: 'Auto', everywhere: 'Everywhere', custom: 'Custom', blur: 'Blur', off: 'Off', opacity: 'Opacity', customize: 'Customize', chrome: 'Window chrome', sidebar: 'Sidebar', content: 'Content', floating: 'Floating surfaces', appearance: 'Appearance', moreSettings: 'More appearance settings…', customizeLink: 'Customize…', toolbarTitle: 'Appearance button', toolbarDescription: 'Shows Appearance in the toolbar. Modifier-click switches light and dark.', reduceTransparency: 'Solid because Reduce Transparency is on', osSettings: 'Open accessibility settings', themeCommand: 'Toggle light and dark', autoDescription: "Adapts to this device: layered glass across supporting desktop windows, and floating glass on phones.", osSettingsUnavailable: "Accessibility settings could not be opened. Open them in your device settings.", ...effectiveTranslationsEnglish.en };


export const glassAppearanceTranslationsEnglish = { en: englishTranslations } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "en">;