import { describe, expectTypeOf, it } from 'vitest';

import type { PluginJsonSchema } from './protocol/index.js';
import {
    compilePluginJsonSchema,
    PluginContributionIdentityV1JsonSchema,
    PluginIdJsonSchema,
} from './manifest.js';
import type { ContributionProtocolManifest } from './contributions/index.js';

describe('public manifest JSON-schema fragments', () => {
    it('composes canonical identity fragments into public protocol schemas', () => {
        expectTypeOf<typeof PluginContributionIdentityV1JsonSchema>()
            .toMatchTypeOf<PluginJsonSchema>();
        expectTypeOf<typeof PluginIdJsonSchema>()
            .toMatchTypeOf<PluginJsonSchema>();
        expectTypeOf<Parameters<typeof compilePluginJsonSchema>[0]>()
            .toEqualTypeOf<PluginJsonSchema>();
        expectTypeOf<
            Date extends Parameters<typeof compilePluginJsonSchema>[0] ? true : false
        >().toEqualTypeOf<false>();
        expectTypeOf<
            ContributionProtocolManifest['operations'][string]['resultSchema']
        >().toEqualTypeOf<PluginJsonSchema>();
        expectTypeOf<
            Date extends ContributionProtocolManifest['operations'][string]['resultSchema']
                ? true
                : false
        >().toEqualTypeOf<false>();
    });
});
