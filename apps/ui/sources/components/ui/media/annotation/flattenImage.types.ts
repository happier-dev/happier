import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import type { ImageAnnotationSource } from './types';

export type FlattenImageResult = Readonly<{ ok: true; png: Uint8Array; width: number; height: number }> | Readonly<{ ok: false; reason: 'canvasUnavailable' | 'decodeFailed' }>;
export type FlattenAnnotatedImage = (source: ImageAnnotationSource, document: ImageMarksDocumentV1) => Promise<FlattenImageResult>;
