import { PromptInvocationsV1Schema } from '@happier-dev/protocol';

import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { storage } from '@/sync/domains/state/storage';

/**
 * The Prompt Library's invocation inventory and its one expansion, projected
 * for callers that hold an Action surface rather than the Account store.
 *
 * Both are PROJECTIONS of incumbent owners and neither is a second parser or a
 * second renderer. `promptInvocationsV1` in Account Settings
 * (`packages/protocol/src/prompts/library/promptInvocationsV1.ts`) is the sole
 * owner of what an invocation is, and
 * `expandPromptTemplateInvocation` is the sole owner of turning one into text —
 * it fetches the referenced artifact when this client has not held it, parses
 * the canonical prompt-doc body and renders the template exactly as the
 * composer does. A caller therefore gets the same words the same slash command
 * would produce in a composer, never a second dialect of them.
 *
 * The listing deliberately returns **no prompt body**. Expanding every entry to
 * answer "which prompts exist" would fetch every artifact in the Library.
 */

export type PromptInvocationsListItem = Readonly<{
    id: string;
    token: string;
    title: string;
    behavior: 'insert' | 'insert_on_send' | 'insert_and_send';
    allowArgs: boolean;
    availableIn: 'global' | 'session_only';
}>;

function readInvocations(): readonly PromptInvocationsListItem[] | null {
    const raw = (storage.getState() as { settings?: { promptInvocationsV1?: unknown } } | null)
        ?.settings?.promptInvocationsV1;
    // The Settings schema's outer `.catch(...)` is appropriate for ordinary UI
    // projection, but not for an authoritative inventory/deletion decision: a
    // malformed value must remain unreadable rather than becoming an empty
    // library. Removing only that fallback keeps the incumbent schema as the
    // single parser and preserves all of its field/default rules.
    const parsed = PromptInvocationsV1Schema.removeCatch().safeParse(raw ?? {});
    if (!parsed.success) return null;
    return parsed.data.entries.map((entry) => ({
        id: entry.id,
        token: entry.token,
        title: entry.title,
        behavior: entry.behavior,
        allowArgs: entry.allowArgs,
        availableIn: entry.availableIn,
    }));
}

export function listPromptInvocationsForActions(
    args: Readonly<{ limit?: number }>,
): Readonly<{
    items: readonly PromptInvocationsListItem[];
    coverage: 'complete' | 'truncated' | 'unavailable';
}> {
    const items = readInvocations();
    if (items === null) return { items: [], coverage: 'unavailable' };
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.floor(args.limit)
        : null;
    if (limit !== null && items.length > limit) {
        return { items: items.slice(0, limit), coverage: 'truncated' };
    }
    // Account Settings already owns the encoded-byte boundary for this value.
    // An unbounded inventory request therefore returns that complete admitted
    // document instead of inventing a second row ceiling that makes a valid
    // invocation beyond the window look deleted.
    return { items, coverage: 'complete' };
}

/**
 * What one resolution settled as.
 *
 * `unknownInvocation` and `unavailable` are deliberately different answers. The
 * first says the stored reference names nothing — the invocation was deleted,
 * and whoever configured that reference has to pick another. The second says
 * the Library holds it but this client could not read its body right now, which
 * is a retry, not a reconfiguration. Collapsing them would tell a reader to fix
 * the wrong thing.
 */
export type PromptInvocationResolveResult =
    | Readonly<{
        status: 'resolved';
        invocationId: string;
        token: string;
        title: string;
        behavior: 'insert' | 'insert_on_send' | 'insert_and_send';
        text: string;
    }>
    | Readonly<{ status: 'unknownInvocation'; invocationId: string }>
    | Readonly<{ status: 'unavailable'; invocationId: string }>;

export async function resolvePromptInvocationForActions(
    args: Readonly<{ invocationId: string; argsText?: string }>,
): Promise<PromptInvocationResolveResult> {
    const invocationId = String(args.invocationId ?? '').trim();
    const raw = (storage.getState() as { settings?: { promptInvocationsV1?: unknown } } | null)
        ?.settings?.promptInvocationsV1;
    const parsed = PromptInvocationsV1Schema.removeCatch().safeParse(raw ?? {});
    if (!parsed.success) return { status: 'unavailable', invocationId };
    const entry = parsed.data.entries.find((candidate) => candidate.id === invocationId);
    if (!entry) return { status: 'unknownInvocation', invocationId };

    // An entry that does not admit arguments is expanded without them rather
    // than refused: the caller asked for this prompt, and dropping the whole
    // resolution over an argument the template would ignore anyway refuses
    // valid work over a presentation rule the composer owns.
    const argsText = entry.allowArgs ? String(args.argsText ?? '') : '';
    try {
        const text = await expandPromptTemplateInvocation({
            targetArtifactId: entry.target.artifactId,
            argsText,
        });
        const trimmed = text.trim();
        if (trimmed.length === 0) return { status: 'unavailable', invocationId };
        return {
            status: 'resolved',
            invocationId,
            token: entry.token,
            title: entry.title,
            behavior: entry.behavior,
            text,
        };
    } catch {
        return { status: 'unavailable', invocationId };
    }
}
