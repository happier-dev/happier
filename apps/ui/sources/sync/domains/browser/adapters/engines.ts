import type { BrowserViewTargetV1 } from '@happier-dev/protocol';
import type {
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol';

export type BrowserAdapterPlatform = 'web' | 'desktop' | 'ios' | 'android';

export type BrowserRenderEngineKind = BrowserRenderEngineKindV1;
export type BrowserSemanticAdapterKind = BrowserSemanticAdapterKindV1;

export type BrowserAdapterTargetKind = BrowserViewTargetV1['kind'];
