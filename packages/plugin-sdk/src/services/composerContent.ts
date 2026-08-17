/** @moduleRealm daemon */
import type { PluginOperationAvailability } from '../availability.js';
import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    type ComposerContentHandleV1,
    type ComposerContentMimeTypeV1,
    type ComposerMediaContentCapabilityV1,
} from '../composer.js';
import type { PluginCancellationOptions } from '../lifecycle.js';
import type { PluginPath } from './io.js';

/** The only daemon-author input: a host-authorized plugin filesystem reference, never a raw path. */
export type ComposerContentStageMediaRequestV1 = Readonly<{
    source: PluginPath;
    name?: string;
    mimeType?: ComposerContentMimeTypeV1;
}>;

/** Operation-level availability is distinct from broad service availability and fails closed when absent. */
export type ComposerContentCapabilitiesV1 = Readonly<{
    [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: PluginOperationAvailability;
}>;

/**
 * Transfer-backed staged-media authority for daemon plugins. The invocation
 * target and contribution owner are host-stamped; plugins cannot supply either.
 */
export interface ComposerContentService {
    capabilities(): ComposerContentCapabilitiesV1;
    stageMedia(
        request: ComposerContentStageMediaRequestV1,
        options?: PluginCancellationOptions,
    ): Promise<ComposerContentHandleV1>;
}

export type { ComposerContentHandleV1, ComposerMediaContentCapabilityV1 };
