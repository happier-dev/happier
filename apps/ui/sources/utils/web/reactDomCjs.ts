let cachedReactDom: any | null = null;

export function requireReactDOM(): any {
    if (cachedReactDom) return cachedReactDom;
    // IMPORTANT:
    // Use `require` so this module can be imported in cross-platform code without pulling `react-dom`
    // into native bundles. Callers should only invoke this on web.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedReactDom = require('react-dom');
    return cachedReactDom;
}

export async function preloadReactDOM(): Promise<any> {
    if (cachedReactDom) return cachedReactDom;
    // Some web runtimes (notably certain webviews/dev bundles) may not expose `require('react-dom')`
    // early enough during the first render. Dynamically import `react-dom` so portal-based overlays
    // can still render as fullscreen fixed layers (escape transformed ancestors).
    // NOTE:
    // Avoid a static `import('react-dom')` so Metro doesn't try to resolve/bundle `react-dom` for native.
    // This function is only called on web (guarded by `Platform.OS === 'web'` at call sites).
    // eslint-disable-next-line no-new-func
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const mod = await dynamicImport('react-dom');
    cachedReactDom = (mod as any)?.default ?? mod;
    return cachedReactDom;
}
