/// <reference lib="dom" />

import { ArtifactHtmlBundleV1Schema, decodeBase64, encodeBase64, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/sharing/public-viewer';

export const ARTIFACT_HTML_SANDBOX = 'allow-scripts';
export const ARTIFACT_HTML_CONTENT_CSP = "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Opened bytes stay inside the isolated shell, never the application DOM. */
export function buildArtifactHtmlSrcdoc(bundleInput: ArtifactHtmlBundleV1, document: Document): string {
    const bundle = ArtifactHtmlBundleV1Schema.parse(bundleInput);
    const text = (path: string): string => new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(bundle.files[path].contentBase64));
    const resolved = new Map<string, string>();
    const resolving = new Set<string>();
    const assetUrl = (reference: string, from: string): string => {
        if (reference.startsWith('#')) return reference;
        if (reference.startsWith('data:')) return reference;
        const url = new URL(reference, `https://bundle.invalid/${from}`);
        if (url.origin !== 'https://bundle.invalid' || url.search || /[\\%]/u.test(reference)) throw new Error('HTML assets must come from this bundle');
        const path = decodeURIComponent(url.pathname.slice(1));
        const asset = bundle.files[path];
        if (!Object.prototype.hasOwnProperty.call(bundle.files, path)) throw new Error(`HTML bundle asset is missing: ${path}`);
        const previous = resolved.get(path);
        if (previous) return previous + url.hash;
        if (resolving.has(path)) throw new Error('Cyclic HTML stylesheet imports are unsupported');
        resolving.add(path);
        let content = asset.contentBase64;
        if (asset.mime.toLowerCase() === 'text/css') content = encodeBase64(new TextEncoder().encode(rewriteCss(text(path), path)));
        const result = `data:${asset.mime};base64,${content}`;
        resolving.delete(path);
        resolved.set(path, result);
        return result + url.hash;
    };
    const rewriteCss = (css: string, from: string): string => {
        // CSS URLs are quoted in the generated result. Escaped URLs are refused
        // rather than guessed; the guest CSP also denies any unresolved network.
        return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/giu,
            (_match, double: string | undefined, single: string | undefined, bare: string | undefined) => `url("${assetUrl(double ?? single ?? bare ?? '', from)}")`)
            .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/giu,
                (_match, double: string | undefined, single: string | undefined) => `@import url("${assetUrl(double ?? single ?? '', from)}")`);
    };
    const parsed = new DOMParser().parseFromString(text(bundle.entrypoint), 'text/html');
    for (const element of parsed.querySelectorAll('base,meta[http-equiv],iframe,frame,object,embed')) element.remove();
    for (const element of parsed.querySelectorAll('script[type="module"],script[type="importmap"]')) {
        if (element) throw new Error('JavaScript modules are unsupported; publish a classic script bundle');
    }
    for (const element of parsed.querySelectorAll('*')) {
        for (const attribute of ['src', 'poster', 'background']) {
            if (element.hasAttribute(attribute)) element.setAttribute(attribute, assetUrl(element.getAttribute(attribute)!, bundle.entrypoint));
        }
        if (element.hasAttribute('srcset')) {
            element.setAttribute('srcset', element.getAttribute('srcset')!.split(',').map(part => {
                const [path, ...descriptor] = part.trim().split(/\s+/u);
                return [assetUrl(path, bundle.entrypoint), ...descriptor].join(' ');
            }).join(', '));
        }
        if (element.tagName === 'LINK' && element.hasAttribute('href')) {
            element.setAttribute('href', assetUrl(element.getAttribute('href')!, bundle.entrypoint));
        }
        if (element.hasAttribute('style')) element.setAttribute('style', rewriteCss(element.getAttribute('style')!, bundle.entrypoint));
    }
    for (const element of parsed.querySelectorAll('style')) element.textContent = rewriteCss(element.textContent ?? '', bundle.entrypoint);
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = ARTIFACT_HTML_CONTENT_CSP;
    parsed.head.prepend(policy);
    return '<!doctype html>\n' + parsed.documentElement.outerHTML;
}

export function renderArtifactHtmlViewer(root: HTMLElement, bundle: ArtifactHtmlBundleV1, title: string): void {
    const iframe = root.ownerDocument.createElement('iframe');
    iframe.setAttribute('sandbox', ARTIFACT_HTML_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('credentialless', '');
    iframe.title = title;
    iframe.style.cssText = 'border:0;width:100%;min-height:80vh;background:white';
    iframe.srcdoc = buildArtifactHtmlSrcdoc(bundle, root.ownerDocument);
    root.replaceChildren(iframe);
}
