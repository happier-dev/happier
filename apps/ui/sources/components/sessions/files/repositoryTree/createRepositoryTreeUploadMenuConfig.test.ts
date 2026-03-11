import { describe, expect, it } from 'vitest';

import { createRepositoryTreeUploadMenuConfig } from './createRepositoryTreeUploadMenuConfig';

describe('createRepositoryTreeUploadMenuConfig', () => {
    it('keeps the upload menu content-sized instead of matching the icon trigger width', () => {
        const config = createRepositoryTreeUploadMenuConfig({
            allowCreateActions: true,
            isWeb: true,
        });

        expect(config.matchTriggerWidth).toBe(false);
    });

    it('disables folder upload outside web while keeping file upload enabled', () => {
        const config = createRepositoryTreeUploadMenuConfig({
            allowCreateActions: true,
            isWeb: false,
        });

        expect(config.items[0].disabled).toBe(false);
        expect(config.items[1].disabled).toBe(true);
    });
});
