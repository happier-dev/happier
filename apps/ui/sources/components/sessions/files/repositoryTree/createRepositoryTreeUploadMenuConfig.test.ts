import { describe, expect, it } from 'vitest';

import { createRepositoryTreeUploadMenuConfig } from './createRepositoryTreeUploadMenuConfig';

describe('createRepositoryTreeUploadMenuConfig', () => {
    it('keeps the upload menu content-sized instead of matching the icon trigger width', () => {
        const config = createRepositoryTreeUploadMenuConfig({
            uploadActionsAvailable: true,
            isWeb: true,
        });

        expect(config.matchTriggerWidth).toBe(false);
    });

    it('disables folder upload outside web while keeping file upload enabled', () => {
        const config = createRepositoryTreeUploadMenuConfig({
            uploadActionsAvailable: true,
            isWeb: false,
        });

        expect(config.items[0].disabled).toBe(false);
        expect(config.items[1].disabled).toBe(true);
    });

    it('disables upload actions when transfers are unavailable', () => {
        const config = createRepositoryTreeUploadMenuConfig({
            uploadActionsAvailable: false,
            isWeb: true,
        });

        expect(config.items[0].disabled).toBe(true);
        expect(config.items[1].disabled).toBe(true);
    });
});
