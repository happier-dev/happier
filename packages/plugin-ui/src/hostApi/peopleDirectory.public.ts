import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

/** One Happier person a plugin may offer to pick: their Account, the name Happier shows, and their handle. */
export type HostPerson = Readonly<{
  accountId: string;
  name: string;
  /** Supporting identity ("@ada", "You"), kept apart from the name. */
  handle?: string;
}>;

export type HostPeopleDirectoryRequest = Readonly<{
  /** The viewer's Home and Account; never inferred from the active tab. */
  scope: Readonly<{ serverId: string; accountId: string }>;
  /** Read only while a picker demands it; nothing is read before. */
  enabled: boolean;
}>;

/** The people the viewer can name (themselves and the people they collaborate with), as the host reads them. */
export type HostPeopleDirectory = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'failed';
  people: readonly HostPerson[];
  retry(): void;
}>;

/**
 * The host's collaboration people directory (the one the share sheet uses). Absent/older hosts return null; a
 * picker then says it cannot list people. A hook: call it unconditionally from a component.
 */
export function useHostPeopleDirectory(
  request: HostPeopleDirectoryRequest,
): HostPeopleDirectory | null {
  return (
    useOptionalPluginUiPresentationHost()?.usePeopleDirectory?.(request) ?? null
  );
}
