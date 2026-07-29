import { describe, expect, it } from 'vitest';

import { defineBrowserAction, defineBrowserTarget } from './index.js';

const display = {
    title: 'Preview',
    iconToken: 'browser',
    tone: 'info',
} as const;

describe('browser SDK helpers', () => {
    it('defines browser targets and actions without exposing browser internals', () => {
        const browserTarget = defineBrowserTarget({
            id: 'preview-target',
            title: 'Preview target',
            url: 'https://preview.example.com',
        });

        const action = defineBrowserAction({
            id: 'open-preview',
            title: 'Open preview',
            action: 'open-preview',
            target: 'preview-target',
            order: 100,
        });

        expect(browserTarget.url).toBe('https://preview.example.com');
        expect(browserTarget.launch).toBe('newView');
        expect(browserTarget.profile).toBe('user');
        expect(action.target).toBe('preview-target');
        expect(action.placement).toBe('toolbar');
    });

    it('rejects attempts to define browser chrome or adapter internals', () => {
        expect(() => defineBrowserAction({
            id: 'bad-browser-action',
            title: 'Bad browser action',
            action: 'open-preview',
            target: 'preview-target',
            chrome: { hideAddressBar: true },
        } as never)).toThrow();
    });
});
