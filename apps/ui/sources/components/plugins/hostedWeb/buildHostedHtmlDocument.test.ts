import { describe, expect, it } from 'vitest';

import { buildHostedHtmlDocument } from './buildHostedHtmlDocument';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/sharing/public-viewer';

function readCsp(document: string): string {
    return /content="([^"]*)"/u.exec(document)?.[1] ?? '';
}

/**
 * The host owns the shell, its Content-Security-Policy and its bootstrap. A
 * by-value document is authored content: it can neither replace them nor widen
 * its own egress by writing markup.
 */
describe('buildHostedHtmlDocument', () => {
    it('keeps generated artifact scripts mount-authorized even when the outer capability requests network access', async () => {
        const bundle = artifactHtmlBundleFromBodyV1('<script src="main.js"></script><script nonce="mount-nonce">globalThis.injected = true</script>');
        bundle.files['main.js'] = { mime: 'text/javascript', contentBase64: '' };
        const document = await buildHostedHtmlDocument(bundle, undefined, {
            generatedArtifactNonce: 'mount-nonce',
            network: 'open',
        });
        expect(readCsp(document)).toContain("script-src 'nonce-mount-nonce';");
        expect(readCsp(document)).not.toMatch(/unsafe-inline|unsafe-eval|https:/u);
        expect(document).toContain('src="data:text/javascript;base64," nonce="mount-nonce"');
        expect(document).toContain('<script>globalThis.injected = true</script>');
    });
    it('accepts the canonical bundle and preserves local executable assets without network admission', async () => {
        const bundle = artifactHtmlBundleFromBodyV1('<script type="module" src="main.js"></script>');
        bundle.files['main.js'] = artifactHtmlBundleFromBodyV1("import './dependency.js'; fetch('./data.json')").files['index.html'];
        bundle.files['main.js'].mime = 'text/javascript';
        bundle.files['dependency.js'] = { mime: 'text/javascript', contentBase64: '' };
        bundle.files['data.json'] = { mime: 'application/json', contentBase64: 'e30=' };
        const document = await buildHostedHtmlDocument(bundle);
        expect(readCsp(document)).toContain('connect-src data:');
        expect(readCsp(document)).not.toContain('https:');
        expect(readCsp(document)).toContain("frame-src 'none'");
        expect(document).toContain('dependency.js');
    });
    it('lets a page follow the viewer\'s light or dark theme when it opts in, and keeps an author\'s own color-scheme choice', async () => {
        const scheme = (html: string) => [...html.matchAll(/<meta name="color-scheme" content="([^"]*)">/gu)].map(match => match[1]);
        // Pages that style both schemes (prefers-color-scheme) follow the theme; ones that set their own colours keep them.
        expect(scheme(await buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>Plain</p>')))).toEqual(['light dark']);
        expect(scheme(await buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<meta name="color-scheme" content="light"><p>Paper</p>'))))
            .toEqual(['light']);
    });
    it('denies every egress by default', async () => {
        expect(readCsp(await buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>Hello</p>')))).toContain('connect-src data:');
    });

    it('applies exact admitted origins to fetch and remote script, style, image and font loads', async () => {
        const csp = readCsp(await buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>Hello</p>'), undefined, {
            networkOrigins: ['https://b.example.com', 'https://a.example.com', 'https://b.example.com'],
        }));
        for (const directive of ['connect-src data:', "script-src 'unsafe-inline' data:", "style-src 'unsafe-inline' data:", 'img-src data:', 'font-src data:']) {
            expect(csp).toContain(`${directive} https://a.example.com https://b.example.com`);
        }
        // Widening one directive must not widen the rest of the profile.
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-src 'none'");
        expect(csp).toContain("form-action 'none'");
        expect(csp).toContain("base-uri 'none'");
    });

    it('requires explicit open admission and does not mistake an empty exact-origin list for open', async () => {
        const bundle = artifactHtmlBundleFromBodyV1('<script>globalThis.local = true</script>');
        expect(readCsp(await buildHostedHtmlDocument(bundle, undefined, { network: 'open' }))).toContain('connect-src data: https:');
        expect(readCsp(await buildHostedHtmlDocument(bundle, undefined, { networkOrigins: [] }))).not.toContain('https:');
    });

    it('uses the Session outer admission even if its bundle carries a saved Artifact open policy', async () => {
        const bundle = { ...artifactHtmlBundleFromBodyV1('<p>Hello</p>'), requestedCapabilities: { network: 'open' as const } };
        expect(readCsp(await buildHostedHtmlDocument(bundle))).not.toContain('https:');
        expect(readCsp(await buildHostedHtmlDocument(bundle, undefined, { network: 'none' }))).not.toContain('https:');
    });

    it('refuses an origin the canonical capability grammar would reject', async () => {
        for (const origin of [
            'https://*.example.com',
            'http://a.example.com',
            'https://a.example.com/v1',
            "https://a.example.com; default-src *",
        ]) {
            await expect(buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>Hello</p>'), undefined, { networkOrigins: [origin] }))
                .rejects.toThrow();
        }
    });

    it('keeps authored markup out of the policy and bootstrap it cannot replace', async () => {
        const document = await buildHostedHtmlDocument(
            artifactHtmlBundleFromBodyV1('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>Hi</p>'),
        );
        // The authored policy is removed; only the host owns document policy.
        expect(readCsp(document)).toContain("default-src 'none'");
        expect(document).not.toContain('default-src *');
    });

    it('installs the host-owned external-link carrier before authored code', async () => {
        const document = await buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<script>globalThis.authorStarted = true</script>'), {
            identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            frameOrigin: 'null',
            hostOrigin: 'https://app.example.test',
        }, { externalHttpLinks: true });
        expect(document).toContain('__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__');
        expect(document.indexOf('EXTERNAL_LINKS')).toBeLessThan(document.indexOf('authorStarted'));
        expect(document).toContain('__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__');
        expect(document.indexOf('__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__')).toBeLessThan(document.indexOf('authorStarted'));
        expect(await buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>unbridged</p>'))).not.toContain('__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__');
    });
});
