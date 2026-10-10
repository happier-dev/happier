import { z } from "zod";
import type { Fastify } from "../../types";
import { resolveStoredContentPublicShareShell } from "@/app/share/storedContentPublicShare";
import { PUBLIC_SHARE_VIEWER_SCRIPT } from "./publicShareViewerBundle.generated";
import { resolveStoredContentPublicShareOrigin } from '@/app/share/storedContentPublicShareOrigin';

const style = "html{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0}main{max-width:48rem;margin:auto;padding:clamp(1rem,4vw,3rem)}h1{overflow-wrap:anywhere}pre{font:inherit;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;padding:.75em 1.25em;cursor:pointer}button:focus-visible{outline:2px solid currentColor;outline-offset:3px}";
// srcdoc inherits this policy. The guest adds its stricter connect/frame policy;
// srcdoc needs no frame source permission. Refuse every guest self-navigation:
// a data/blob document would otherwise regain this shell's fetch permission.
export const ARTIFACT_HTML_SHELL_CSP = `default-src 'none'; script-src 'self' 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; frame-src 'none'; worker-src 'none'; connect-src 'self' data:; base-uri 'none'; form-action 'none'; object-src blob:`;
const csp = `${ARTIFACT_HTML_SHELL_CSP}; frame-ancestors 'none'`;

/** Private preview needs ordinary Artifact access, not public-link availability. */
export function registerArtifactHtmlViewerRoutes(app: Fastify): void {
    const privateSchema = { params: z.object({ artifactId: z.string().min(1) }).strict() };
    for (const asset of [false, true]) {
        app.get(asset ? '/a/:artifactId/viewer.js' : '/a/:artifactId', { schema: privateSchema }, async (request, reply) => {
            const origin = resolveStoredContentPublicShareOrigin(request.params.artifactId);
            reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
            if (!origin || new URL(origin).hostname !== request.hostname || request.headers.authorization || request.headers.cookie) {
                return reply.code(404).send({ error: 'artifact_html_preview_unavailable' });
            }
            if (asset) return reply.type('application/javascript; charset=utf-8').send(PUBLIC_SHARE_VIEWER_SCRIPT);
            reply.header('Content-Security-Policy', ARTIFACT_HTML_SHELL_CSP);
            reply.header('Cross-Origin-Opener-Policy', 'same-origin');
            reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
            return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HTML Artifact · Happier</title><style>${style}</style></head><body><main id="public-share-viewer" aria-live="polite">Opening HTML document…</main><script src="/a/${encodeURIComponent(request.params.artifactId)}/viewer.js" defer></script></body></html>`);
        });
    }
}

/** Delivery delegates every public admission decision to the stored-content share owner. */
export function registerPublicShareViewerRoutes(app: Fastify): void {
    const schema = { params: z.object({ lookupId: z.string().min(1) }).strict() };
    for (const asset of [false, true]) {
        app.get(asset ? "/s/:lookupId/viewer.js" : "/s/:lookupId", { schema }, async (request, reply) => {
            reply.header("Cache-Control", "no-store");
            reply.header("Referrer-Policy", "no-referrer");
            reply.header("X-Content-Type-Options", "nosniff");
            reply.header("Cross-Origin-Resource-Policy", "same-origin");
            if (request.headers.authorization || request.headers.cookie) return reply.code(404).send({ error: 'public_share_unavailable' });
            // This static client contains no subject bytes. It must remain loadable
            // after revocation so the same viewer can render its unavailable state.
            if (asset) return reply.type("application/javascript; charset=utf-8").send(PUBLIC_SHARE_VIEWER_SCRIPT);
            const share = await resolveStoredContentPublicShareShell(request.params.lookupId, request.hostname, process.env, request.ip);
            if (!share) reply.code(404);
            else if ("error" in share) reply.code(429);
            reply.header("Content-Security-Policy", csp);
            reply.header("Cross-Origin-Opener-Policy", "same-origin");
            reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
            // Only the encoded lookup enters the asset URL. The fragment has no
            // server representation and no plaintext content is embedded.
            const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared content · Happier</title><style>${style}</style></head><body><main id="public-share-viewer" aria-live="polite"><h1>Shared content</h1><p>Opening shared content…</p></main><script src="/s/${encodeURIComponent(request.params.lookupId)}/viewer.js" defer></script></body></html>`;
            return reply.type("text/html; charset=utf-8").send(html);
        });
    }
}
