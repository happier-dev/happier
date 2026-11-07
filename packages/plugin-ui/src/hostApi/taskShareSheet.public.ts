import type { RefObject } from 'react';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

/** Exact task identity and the viewer's Home/Account scope; never inferred from the active tab. */
export type HostTaskShareRef = Readonly<{
  taskId: string;
  ownerAccountId: string;
  scope: Readonly<{ serverId: string; accountId: string }>;
}>;

export type HostTaskShareSheet = Readonly<{
  open(input: Readonly<{
    taskRef: HostTaskShareRef;
    title: string;
    /** The existing menu trigger's anchorRef, for anchored desktop presentation. */
    anchor?: RefObject<unknown>;
  }>): void;
}>;

/** Open the host's incumbent task ShareSheet; absent/older hosts return null so authors hide the entry. */
export function useHostTaskShareSheet(): HostTaskShareSheet | null {
  return useOptionalPluginUiPresentationHost()?.taskShareSheet ?? null;
}
