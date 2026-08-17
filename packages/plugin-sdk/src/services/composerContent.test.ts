import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    type ComposerContentHandleV1,
    type ComposerContentMimeTypeV1,
} from '../composer.js';
import type { PluginOperationAvailability } from '../availability.js';
import type { PluginCancellationOptions } from '../lifecycle.js';
import type { PluginPath } from './io.js';
import type {
    ComposerContentCapabilitiesV1,
    ComposerContentService,
    ComposerContentStageMediaRequestV1,
} from './composerContent.js';

describe('Composer content daemon service contract', () => {
    it('accepts one host-authorized PluginPath and leaves target, owner, bytes, and transfer state host-private', () => {
        expectTypeOf<ComposerContentStageMediaRequestV1>().toEqualTypeOf<Readonly<{
            source: PluginPath;
            name?: string;
            mimeType?: ComposerContentMimeTypeV1;
        }>>();
        expectTypeOf<ComposerContentStageMediaRequestV1>().not.toHaveProperty('executionTarget');
        expectTypeOf<ComposerContentStageMediaRequestV1>().not.toHaveProperty('owner');
        expectTypeOf<ComposerContentStageMediaRequestV1>().not.toHaveProperty('path');
        expectTypeOf<ComposerContentStageMediaRequestV1>().not.toHaveProperty('uri');
        expectTypeOf<ComposerContentStageMediaRequestV1>().not.toHaveProperty('bytes');
        expectTypeOf<ComposerContentStageMediaRequestV1>().not.toHaveProperty('transferSessionId');
        expectTypeOf<ComposerContentService['stageMedia']>().parameters.toEqualTypeOf<[
            request: ComposerContentStageMediaRequestV1,
            options?: PluginCancellationOptions,
        ]>();
        expectTypeOf<ComposerContentService['stageMedia']>().returns.resolves
            .toEqualTypeOf<ComposerContentHandleV1>();
    });

    it('uses the one exact operation capability for both built-in and external daemon plugins', () => {
        expect(COMPOSER_MEDIA_CONTENT_CAPABILITY_V1).toBe('composer.mediaContent.v1');
        expectTypeOf<ComposerContentCapabilitiesV1[typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]>()
            .toEqualTypeOf<PluginOperationAvailability>();
        expectTypeOf<ComposerContentCapabilitiesV1>().not.toHaveProperty('builtIn');
        expectTypeOf<ComposerContentCapabilitiesV1>().not.toHaveProperty('external');
    });
});
