import { describe, expect, it } from 'vitest';

import { selectBrowserSecurityOriginModel } from './securityOrigin';
import type { BrowserControlViewState } from '../control';

function view(overrides: Partial<BrowserControlViewState>): BrowserControlViewState {
    return {
        browserSessionId: 'bs_1',
        viewId: 'view_1',
        target: { kind: 'externalUrl', targetId: 'externalUrl:x', url: 'https://example.test/' } as BrowserControlViewState['target'],
        platform: 'web',
        adapterKind: 'externalUrl',
        engineKind: 'webIframe',
        adapterCapabilities: {} as BrowserControlViewState['adapterCapabilities'],
        currentUrl: null,
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: null,
        faviconUrl: null,
        loadingState: 'idle',
        loadingProgress: null,
        navigationGeneration: 1,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: null,
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
        ...overrides,
    };
}

describe('selectBrowserSecurityOriginModel', () => {
    it('returns unknown for a null view', () => {
        expect(selectBrowserSecurityOriginModel(null)).toEqual({ securityLevel: 'unknown', originLabel: null });
    });

    it('classifies an https origin as secure with its host', () => {
        const model = selectBrowserSecurityOriginModel(view({ securityOrigin: 'https://app.example.test' }));
        expect(model).toEqual({ securityLevel: 'secure', originLabel: 'app.example.test' });
    });

    it('classifies a loopback http origin as local (trusted-by-locality, not TLS)', () => {
        const model = selectBrowserSecurityOriginModel(view({ securityOrigin: 'http://localhost:5173' }));
        expect(model).toEqual({ securityLevel: 'local', originLabel: 'localhost:5173' });
    });

    it('classifies a 127.0.0.1 http origin as local', () => {
        const model = selectBrowserSecurityOriginModel(view({ securityOrigin: 'http://127.0.0.1:3000' }));
        expect(model).toEqual({ securityLevel: 'local', originLabel: '127.0.0.1:3000' });
    });

    it('classifies a plaintext non-loopback http origin as insecure', () => {
        const model = selectBrowserSecurityOriginModel(view({ securityOrigin: 'http://insecure.example.test' }));
        expect(model).toEqual({ securityLevel: 'insecure', originLabel: 'insecure.example.test' });
    });

    it('falls back to the navigated currentUrl when no explicit securityOrigin is tracked', () => {
        const model = selectBrowserSecurityOriginModel(view({ securityOrigin: null, currentUrl: 'https://fallback.example.test/page' }));
        expect(model).toEqual({ securityLevel: 'secure', originLabel: 'fallback.example.test' });
    });

    it('treats a hosted plugin surface as internal (TLS posture is not applicable)', () => {
        const model = selectBrowserSecurityOriginModel(view({
            target: { kind: 'hostedPluginWeb', targetId: 'hostedPluginWeb:p', pluginId: 'p' } as BrowserControlViewState['target'],
            adapterKind: 'hostedPlugin',
            securityOrigin: 'http://127.0.0.1:9000',
        }));
        expect(model.securityLevel).toBe('internal');
    });

    it('returns unknown when no origin has resolved yet', () => {
        const model = selectBrowserSecurityOriginModel(view({ securityOrigin: null, currentUrl: null }));
        expect(model).toEqual({ securityLevel: 'unknown', originLabel: null });
    });
});
