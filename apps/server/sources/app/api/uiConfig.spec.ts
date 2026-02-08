import { describe, expect, it } from 'vitest';
import { resolveUiConfig } from './uiConfig';

describe('resolveUiConfig', () => {
    it('returns null dir when UI is not configured', () => {
        const cfg = resolveUiConfig({});
        expect(cfg.dir).toBeNull();
    });

    it('uses HAPPIER_SERVER_UI_DIR and defaults prefix to /', () => {
        const cfg = resolveUiConfig({ HAPPIER_SERVER_UI_DIR: '/tmp/ui' });
        expect(cfg.dir).toBe('/tmp/ui');
        expect(cfg.mountRoot).toBe(true);
        expect(cfg.prefix).toBe('/');
    });

    it('normalizes a non-root prefix by stripping trailing slash', () => {
        const cfg = resolveUiConfig({ HAPPIER_SERVER_UI_DIR: '/tmp/ui', HAPPIER_SERVER_UI_PREFIX: '/ui/' });
        expect(cfg.mountRoot).toBe(false);
        expect(cfg.prefix).toBe('/ui');
    });

    it('supports HAPPIER_SERVER_LIGHT_UI_* env vars', () => {
        const cfg = resolveUiConfig({ HAPPIER_SERVER_LIGHT_UI_DIR: '/tmp/ui', HAPPIER_SERVER_LIGHT_UI_PREFIX: '/ui' });
        expect(cfg.dir).toBe('/tmp/ui');
        expect(cfg.mountRoot).toBe(false);
        expect(cfg.prefix).toBe('/ui');
    });

    it('defaults required=false unless explicitly set', () => {
        const cfg = resolveUiConfig({ HAPPIER_SERVER_UI_DIR: '/tmp/ui' });
        expect(cfg.required).toBe(false);
    });

    it('sets required=true when HAPPIER_SERVER_UI_REQUIRED=1', () => {
        const cfg = resolveUiConfig({ HAPPIER_SERVER_UI_DIR: '/tmp/ui', HAPPIER_SERVER_UI_REQUIRED: '1' });
        expect(cfg.required).toBe(true);
    });

    it('treats HAPPIER_SERVER_UI_REQUIRED=false as false', () => {
        const cfg = resolveUiConfig({ HAPPIER_SERVER_UI_DIR: '/tmp/ui', HAPPIER_SERVER_UI_REQUIRED: 'false' });
        expect(cfg.required).toBe(false);
    });
});
