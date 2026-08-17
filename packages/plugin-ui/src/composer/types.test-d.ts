import type { ComposerHandle } from './service.js';
import type { ComposerDecorationSetV1 } from './types.js';

declare const composer: ComposerHandle;

// Clearing a caller-owned decoration key is an operation-level capability.
void composer.setDecorations('example.review', null);

// @ts-expect-error A decoration payload remains the canonical non-null SDK value.
const clearIsNotADecorationSet: ComposerDecorationSetV1 = null;
void clearIsNotADecorationSet;
