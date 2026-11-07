import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type SessionInfoSectionContentFact = 'unknown' | 'empty' | 'present';

/** An already-admitted summary of the whole section, never a visible page or an unloaded default. */
export type SessionInfoHeldSectionSummary = Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    status: 'ready' | 'loading' | 'stale' | 'denied' | 'error';
    coverage: 'complete' | 'partial';
    count: number;
}>;

export type SessionInfoAddToFactsInput = Readonly<{
    address: SessionAddress;
    /** The credential owner of the held observations, not the currently focused Home. */
    scope: ServerAccountScope | null;
    /** Covers both Starts here and Writes here, including scheduled work. Omit unless already known. */
    habits?: SessionInfoHeldSectionSummary | null;
    /** Covers the People section, not only one grant page, online presence or this viewer's access. */
    people?: SessionInfoHeldSectionSummary | null;
    /** The existing Workspace sync section's admitted relationship summary. */
    anotherMachine?: SessionInfoHeldSectionSummary | null;
}>;

function readFact(input: SessionInfoAddToFactsInput, held: SessionInfoHeldSectionSummary | null | undefined): SessionInfoSectionContentFact {
    if (!held || !input.scope || !areServerAccountScopesEqual(input.scope, held.scope)
        || !areServerProfileIdentifiersEquivalent(input.address.serverId, held.scope.serverId)
        || input.address.sessionId !== held.sessionId || held.status !== 'ready') return 'unknown';
    if (held.count > 0) return 'present';
    return held.count === 0 && held.coverage === 'complete' ? 'empty' : 'unknown';
}

/**
 * Controlled Info composition facts. This hook deliberately acquires nothing: do not mount Habits,
 * People or Workspace sync detail controllers to fill these operands. A caller without an existing
 * current complete summary omits it, preserving that section's slot and explanation as unknown.
 */
export function useSessionInfoAddToFacts(input: SessionInfoAddToFactsInput): Readonly<{
    habits: SessionInfoSectionContentFact;
    people: SessionInfoSectionContentFact;
    anotherMachine: SessionInfoSectionContentFact;
}> {
    return {
        habits: readFact(input, input.habits),
        people: readFact(input, input.people),
        anotherMachine: readFact(input, input.anotherMachine),
    };
}
