import { z } from "zod/mini";
import type { Fastify } from "../../types";
import { resolveStoredContentPublicShareDelivery } from '@/app/share/storedContentPublicShareOrigin';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { ARTIFACT_HTML_SHELL_CSP_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';

const style = "/* The public reader: Happier's calm reading column (704px), its type roles and one primary action. No Account chrome, no network fonts. */:root{color-scheme:light dark;--bg:#fff;--fg:#222224;--fg2:#6c6c70;--fg3:#99999d;--line:rgba(0,0,0,.08);--fill:rgba(0,0,0,.035);--btn:#1c1c1e;--btn-fg:#fff;--focus:#2f6fec}@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--fg2:#a1a1a6;--fg3:#6e6e73;--line:rgba(255,255,255,.1);--fill:rgba(255,255,255,.05);--btn:#f2f2f4;--btn-fg:#141416;--focus:#7ea6ff}}html{font:15px/1.6 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased;background:var(--bg);color:var(--fg)}body{margin:0}main{box-sizing:border-box;max-width:44rem;margin:0 auto;padding:clamp(2rem,7vw,4.5rem) clamp(1rem,4vw,1.5rem) 4rem}h1{margin:0 0 .75rem;font-size:1.75rem;line-height:1.2;font-weight:700;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}h2{margin:2rem 0 .5rem;font-size:1.0625rem;line-height:1.35;font-weight:600;letter-spacing:-.01em}p{margin:0 0 1.25rem;max-width:62ch;color:var(--fg2);text-wrap:pretty}pre{margin:1.25rem 0 0;font:inherit;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}section{padding:1rem 0;border-top:1px solid var(--line)}section:first-of-type{border-top:0}img{display:block;max-width:100%;height:auto;margin:1.25rem 0;border-radius:12px;outline:1px solid var(--line);outline-offset:-1px}object,iframe{display:block;margin:1.25rem 0;border-radius:12px}button,a[download]{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:2.25rem;padding:0 1rem;border-radius:10px;font-family:inherit;font-size:.875rem;font-weight:600;line-height:1;text-decoration:none;cursor:pointer;transition:transform 120ms cubic-bezier(.2,0,0,1),opacity 120ms ease}button{border:0;background:var(--btn);color:var(--btn-fg)}a[download]{margin-top:.25rem;border:1px solid var(--line);background:var(--fill);color:var(--fg)}@media (hover:hover){button:hover{opacity:.88}a[download]:hover{background:var(--line)}}button:active,a[download]:active{transform:scale(.97)}button:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}@media (prefers-reduced-motion:reduce){button,a[download]{transition:none}button:active,a[download]:active{transform:none}}";
// Encrypted stored policy is opened by the viewer. The canonical shell ceiling
// permits HTTPS; each opaque guest applies its own admitted, narrower policy.
const csp = `${ARTIFACT_HTML_SHELL_CSP_V1}; frame-ancestors 'none'`;

let publicShareViewerScript: Promise<string> | undefined;

/** One static payload promise for post-listen preparation and both JS routes. */
export function loadPublicShareViewerScript(): Promise<string> {
    return publicShareViewerScript ??= import('./publicShareViewerBundle.generated')
        .then(module => module.PUBLIC_SHARE_VIEWER_SCRIPT);
}

/** Static delivery uses configured origins; every content request admits its own share. */
export function registerPublicShareViewerRoutes(app: Fastify): void {
    const schema = { params: z.strictObject({ lookupId: z.string().check(z.minLength(1)) }) };
    // Fastify runs onListen after publishing the listening socket; do not return
    // this promise or make startup await the generated client's evaluation.
    app.addHook('onListen', () => {
        void loadPublicShareViewerScript().catch(error => {
            app.log.error({ err: error, viewer: 'share' }, 'Post-listen public viewer preparation failed');
        });
    });
    for (const asset of [false, true]) {
        app.get(asset ? "/s/:lookupId/viewer.js" : "/s/:lookupId", { schema }, async (request, reply) => {
            reply.header("Cache-Control", "no-store");
            reply.header("Referrer-Policy", "no-referrer");
            reply.header("X-Content-Type-Options", "nosniff");
            reply.header("Cross-Origin-Resource-Policy", "same-origin");
            const configEnv = await readRequestHomeEnv(request);
            // Static bytes need only the configured viewer host, not a share lookup.
            // The content API separately binds that host to the actual subject.
            const delivery = resolveStoredContentPublicShareDelivery(request.hostname.split('.')[0]!, configEnv);
            const configuredHost = delivery && new URL(delivery.origin).hostname === request.hostname;
            const mainHost = configuredHost && delivery.mode === 'main-origin';
            if (!configuredHost || request.headers.authorization || (request.headers.cookie && !mainHost)) {
                return reply.code(404).send({ error: 'public_share_unavailable' });
            }
            // This static client contains no subject bytes. It must remain loadable
            // after revocation so the same viewer can render its unavailable state.
            // Isolated static delivery remains share-independent; main-origin cookie
            // admission uses only the configured HTTPS hostname, never an Account.
            if (asset) {
                return reply.type("application/javascript; charset=utf-8").send(await loadPublicShareViewerScript());
            }
            reply.header("Content-Security-Policy", csp);
            reply.header("Cross-Origin-Opener-Policy", "same-origin");
            reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
            // Only the encoded lookup enters the asset URL. The fragment has no
            // server representation and no plaintext content is embedded.
            const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared content · Happier</title><style>${style}</style></head><body><main id="public-share-viewer" data-public-share-delivery="${delivery?.mode ?? ''}" aria-live="polite"><h1>Shared content</h1><p>Opening shared content…</p></main><script src="/s/${encodeURIComponent(request.params.lookupId)}/viewer.js" defer></script></body></html>`;
            return reply.type("text/html; charset=utf-8").send(html);
        });
    }
}
