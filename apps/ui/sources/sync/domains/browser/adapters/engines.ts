import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import type {
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
} from '@happier-dev/protocol/browser/adapters/kinds';

export type BrowserAdapterPlatform = 'web' | 'desktop' | 'ios' | 'android';

export type BrowserRenderEngineKind = BrowserRenderEngineKindV1;
export type BrowserSemanticAdapterKind = BrowserSemanticAdapterKindV1;

export type BrowserAdapterTargetKind = BrowserViewTargetV1['kind'];
