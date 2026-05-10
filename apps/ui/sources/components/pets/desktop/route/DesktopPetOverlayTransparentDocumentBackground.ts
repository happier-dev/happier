export function applyDesktopPetOverlayTransparentDocumentBackground(
    targetDocument?: Document,
): () => void {
    const activeDocument = targetDocument
        ?? (typeof document !== 'undefined' ? document : null);
    if (!activeDocument) {
        return () => {};
    }

    const styleElementId = 'desktop-pet-overlay-transparent-style';
    const existingStyleElement = activeDocument.getElementById?.(styleElementId);
    const canInjectStylesheet = typeof activeDocument.createElement === 'function';
    const styleElement = canInjectStylesheet
        ? (existingStyleElement && (existingStyleElement as unknown as { nodeName?: string }).nodeName === 'STYLE'
            ? existingStyleElement as HTMLStyleElement
            : activeDocument.createElement('style'))
        : null;
    const injectedStyleElement = canInjectStylesheet && !existingStyleElement;

    if (styleElement) {
        styleElement.id = styleElementId;
        styleElement.textContent = `
            html, body, #root, #app, #expo-root {
                background: transparent !important;
                background-color: transparent !important;
                margin: 0 !important;
                padding: 0 !important;
                overflow: hidden !important;
                height: 100% !important;
                width: 100% !important;
            }
            #root > div, #root > div > div, #root > div > div > div {
                background: transparent !important;
                background-color: transparent !important;
                margin: 0 !important;
                padding: 0 !important;
                height: 100% !important;
                width: 100% !important;
            }
        `;
        if (injectedStyleElement) {
            activeDocument.head?.appendChild?.(styleElement);
        }
    }

    const htmlStyle = activeDocument.documentElement?.style;
    const bodyStyle = activeDocument.body?.style;
    const rootStyle = activeDocument.getElementById?.('root')?.style;
    if (!htmlStyle || !bodyStyle) {
        return () => {
            if (injectedStyleElement) {
                styleElement?.remove?.();
            }
        };
    }

    const previousHtmlBackgroundColor = htmlStyle.backgroundColor;
    const previousHtmlBackground = htmlStyle.background;
    const previousBodyBackgroundColor = bodyStyle.backgroundColor;
    const previousBodyBackground = bodyStyle.background;
    const previousBodyMargin = bodyStyle.margin;
    const previousBodyPadding = bodyStyle.padding;
    const previousBodyOverflow = bodyStyle.overflow;
    const previousRootBackgroundColor = rootStyle?.backgroundColor;
    const previousRootBackground = rootStyle?.background;
    const previousRootMargin = rootStyle?.margin;
    const previousRootPadding = rootStyle?.padding;

    htmlStyle.backgroundColor = 'transparent';
    htmlStyle.background = 'transparent';
    bodyStyle.backgroundColor = 'transparent';
    bodyStyle.background = 'transparent';
    bodyStyle.margin = '0px';
    bodyStyle.padding = '0px';
    bodyStyle.overflow = 'hidden';
    if (rootStyle) {
        rootStyle.backgroundColor = 'transparent';
        rootStyle.background = 'transparent';
        rootStyle.margin = '0px';
        rootStyle.padding = '0px';
    }

    return () => {
        htmlStyle.backgroundColor = previousHtmlBackgroundColor;
        htmlStyle.background = previousHtmlBackground;
        bodyStyle.backgroundColor = previousBodyBackgroundColor;
        bodyStyle.background = previousBodyBackground;
        bodyStyle.margin = previousBodyMargin;
        bodyStyle.padding = previousBodyPadding;
        bodyStyle.overflow = previousBodyOverflow;
        if (rootStyle) {
            rootStyle.backgroundColor = previousRootBackgroundColor ?? '';
            rootStyle.background = previousRootBackground ?? '';
            rootStyle.margin = previousRootMargin ?? '';
            rootStyle.padding = previousRootPadding ?? '';
        }
        if (injectedStyleElement) {
            styleElement?.remove?.();
        }
    };
}
