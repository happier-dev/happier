import { describe, expectTypeOf, it } from 'vitest';

import type { ComposerSurfaceInputV1 as ProtocolComposerSurfaceInputV1 } from '@happier-dev/protocol';

import type { ComposerSurfaceInputV1 } from './publicContract.js';

describe('Composer surface launch carrier public projection', () => {
    it('keeps the SDK declaration structurally identical to Protocol’s closed carrier', () => {
        expectTypeOf<ComposerSurfaceInputV1>()
            .toEqualTypeOf<ProtocolComposerSurfaceInputV1>();
    });
});
