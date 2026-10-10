/// <reference lib="dom" />

import { ARTIFACT_HTML_SANDBOX_V1, buildArtifactHtmlDocumentV1, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/sharing/public-viewer';

/** Opened bytes stay inside the isolated shell, never the application DOM. */
export function buildArtifactHtmlSrcdoc(bundle: ArtifactHtmlBundleV1, _document: Document): string {
    return buildArtifactHtmlDocumentV1(bundle);
}

export function renderArtifactHtmlViewer(root: HTMLElement, bundle: ArtifactHtmlBundleV1, title: string): void {
    const iframe = root.ownerDocument.createElement('iframe');
    iframe.setAttribute('sandbox', ARTIFACT_HTML_SANDBOX_V1);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('credentialless', '');
    iframe.title = title;
    iframe.style.cssText = 'border:0;width:100%;min-height:80vh;background:white';
    iframe.srcdoc = buildArtifactHtmlSrcdoc(bundle, root.ownerDocument);
    root.replaceChildren(iframe);
}
