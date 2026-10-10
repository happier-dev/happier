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
    it('accepts the canonical bundle and preserves local executable assets without network admission', () => {
        const bundle = artifactHtmlBundleFromBodyV1('<script type="module" src="main.js"></script>');
        bundle.files['main.js'] = artifactHtmlBundleFromBodyV1("import './dependency.js'; fetch('./data.json')").files['index.html'];
        bundle.files['main.js'].mime = 'text/javascript';
        bundle.files['dependency.js'] = { mime: 'text/javascript', contentBase64: '' };
        bundle.files['data.json'] = { mime: 'application/json', contentBase64: 'e30=' };
        const document = buildHostedHtmlDocument(bundle);
        expect(readCsp(document)).toContain('connect-src data:');
        expect(readCsp(document)).not.toContain('https:');
        expect(readCsp(document)).toContain("frame-src 'none'");
        expect(document).toContain('dependency.js');
    });
    it('denies every egress by default', () => {
        expect(readCsp(buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>Hello</p>')))).toContain('connect-src data:');
    });

    it('keeps network closed until the admitted policy is wired by E3', () => {
        const csp = readCsp(buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>Hello</p>'), undefined, {
            networkOrigins: ['https://b.example.com', 'https://a.example.com', 'https://b.example.com'],
        }));
        expect(csp).toContain('connect-src data:');
        expect(csp).not.toContain('https://');
        // Widening one directive must not widen the rest of the profile.
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-src 'none'");
        expect(csp).toContain("form-action 'none'");
        expect(csp).toContain("base-uri 'none'");
    });

    it('refuses an origin the canonical capability grammar would reject', () => {
        for (const origin of [
            'https://*.example.com',
            'http://a.example.com',
            'https://a.example.com/v1',
            "https://a.example.com; default-src *",
        ]) {
            expect(() => buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<p>Hello</p>'), undefined, { networkOrigins: [origin] }))
                .toThrow();
        }
    });

    it('keeps authored markup out of the policy and bootstrap it cannot replace', () => {
        const document = buildHostedHtmlDocument(
            artifactHtmlBundleFromBodyV1('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>Hi</p>'),
        );
        // The authored policy is removed; only the host owns document policy.
        expect(readCsp(document)).toContain("default-src 'none'");
        expect(document).not.toContain('default-src *');
    });

    it('installs the host-owned external-link carrier before authored code', () => {
        const document = buildHostedHtmlDocument(artifactHtmlBundleFromBodyV1('<script>globalThis.authorStarted = true</script>'), {
            identity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            frameOrigin: 'null',
            hostOrigin: 'https://app.example.test',
        }, { externalHttpLinks: true });
        expect(document).toContain('__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__');
        expect(document.indexOf('EXTERNAL_LINKS')).toBeLessThan(document.indexOf('authorStarted'));
    });
});
