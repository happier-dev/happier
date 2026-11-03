import * as React from 'react';
import {
    EnvironmentSecretBindingV1Schema, environmentSecretBindingIdentityV1,
    type DeploymentEnvironmentHeaderV1, type EnvironmentSecretBindingV1, type EnvironmentVariableBindingV1,
} from '@happier-dev/deployment-protocol';
import { projectEnvironmentSecretBindingsV1, type EnvironmentSecretBindingProjectionV1 } from '@happier-dev/deployments';

type EditResult = Readonly<{ ok: true }> | Readonly<{
    ok: false;
    error: 'invalid_binding' | 'duplicate_identity' | 'missing_binding' | 'managed' | 'selection_required' | 'no_draft'
        | 'unavailable' | 'unknown_reference';
}>;
type SecretSource = Extract<EnvironmentSecretBindingV1['source'], { kind: 'secret' }>;
type VariableSource = EnvironmentVariableBindingV1['source'];
type VariableBinding = Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>;
type BulkPhase = 'build' | 'runtime' | 'both';
/**
 * One entry of the whole-file bulk edit that differs from the current bindings. `source` is an existing
 * source kept by its ‹reference›; otherwise `value` is a literal typed here, saved as a Saved Secret when it
 * is classified `secret` (never bound raw) or as a plain value.
 */
type BulkRow = Readonly<{
    name: string;
    phase: BulkPhase;
    change: 'added' | 'changed';
    value: string;
    source: VariableSource | null;
    classification: 'secret' | 'plain';
}>;
type BulkState = Readonly<{ scopeKey: unknown; rows: readonly BulkRow[]; removed: readonly string[]; replaced: readonly string[] }>;
type BulkInput = Readonly<{
    text: string;
    kinds: Readonly<Record<string, BulkRow['classification']>>;
    sources: Readonly<Record<string, SecretSource>>;
}>;
/** How a kept source reads in the file, between ‹ ›. The page passes Saved Secret and Environment names. */
export type EnvironmentBulkSourceLabel = (source: Exclude<VariableSource, { kind: 'value' }>) => string;
const ok = { ok: true } as const;
const PHASE_NOTE = /\s+#\s*(build \+ runtime|build|runtime)\s*$/u;
/** Lab r3 `variables/paste`: Happier guesses a secret from the name; the person decides before Save. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS$|DSN|CREDENTIAL|PRIVATE|AUTH/iu;

export const defaultEnvironmentBulkSourceLabel: EnvironmentBulkSourceLabel = source => {
    switch (source.kind) {
        case 'secret': return `saved secret · revision ${source.resourceRevision}`;
        case 'reference': return `${source.export} from another environment`;
        case 'deploymentFact': return `deployment ${source.fact}`;
    }
};

/** A literal that survives one `NAME = value` line unchanged; anything else is kept by reference. */
function literalFits(value: string): boolean {
    return !/[\r\n]/u.test(value) && value === value.trim() && !value.startsWith('‹') && !PHASE_NOTE.test(` ${value}`)
        && !/^(["']).*\1$/u.test(value);
}
function sameSource(a: VariableSource, b: VariableSource): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
function phasesOf(phase: BulkPhase) {
    return phase === 'both' ? ['build', 'runtime'] as const : [phase];
}
/** Lines grouped as the table reads them: a name bound identically for build and runtime is one entry. */
function fileEntries(bindings: readonly EnvironmentSecretBindingV1[]) {
    const out: Array<{ name: string; phase: BulkPhase; source: VariableSource }> = [];
    for (const binding of bindings) {
        if (binding.purpose !== 'variable') continue;
        const sibling = out.find(entry => entry.name === binding.name && entry.phase !== 'both'
            && entry.phase !== binding.phase && sameSource(entry.source, binding.source));
        if (sibling) sibling.phase = 'both';
        else out.push({ name: binding.name, phase: binding.phase, source: binding.source });
    }
    return out;
}
function token(source: VariableSource, label: EnvironmentBulkSourceLabel): string | null {
    if (source.kind === 'value') return literalFits(source.value) ? null : '‹value set in the table›';
    return `‹${label(source)}›`;
}

/**
 * Controlled local data for P40's Variables surface. Only its reviewed parent
 * invokes bindings.set; this hook neither reads secret bodies nor persists.
 */
export function useEnvironmentSecretBindingsEditor(options: Readonly<{
    bindings: readonly EnvironmentSecretBindingV1[];
    environmentOwner?: DeploymentEnvironmentHeaderV1['owner'];
    scopeKey?: unknown;
    readOnly?: boolean;
    isCurrent?: () => boolean;
    managedIdentities?: ReadonlySet<string>;
    onChangeBindings(bindings: readonly EnvironmentSecretBindingV1[]): void;
}>) {
    const current = React.useRef(options);
    current.current = options;
    const previousRows = React.useRef<readonly EnvironmentSecretBindingProjectionV1[]>([]);
    const rows = React.useMemo(() => {
        const next = projectEnvironmentSecretBindingsV1(options.bindings, previousRows.current, options.environmentOwner);
        previousRows.current = next;
        return next;
    }, [options.bindings, options.environmentOwner]);
    const scopeKey = options.scopeKey;
    const [bulkState, setBulk] = React.useState<BulkState | null>(null);
    // The Variables body can unmount on a page change; its unfinished file and
    // already-created references share the editor's existing draft lifetime.
    const [inputState, setInput] = React.useState<Readonly<{ scopeKey: unknown; value: BulkInput }> | null>(null);
    const currentBulk = React.useRef(bulkState);
    currentBulk.current = bulkState;
    function publishBulk(next: BulkState | null) {
        currentBulk.current = next;
        setBulk(next);
    }
    const available = !options.readOnly && options.isCurrent?.() !== false;
    const staged = available && bulkState !== null && bulkState.scopeKey === scopeKey ? bulkState : null;
    React.useEffect(() => {
        if (!available || currentBulk.current?.scopeKey !== scopeKey) {
            publishBulk(null);
            setInput(null);
        }
    }, [scopeKey, available]);
    function canWrite() {
        return current.current.scopeKey === scopeKey && !current.current.readOnly && current.current.isCurrent?.() !== false;
    }

    function apply(set: readonly EnvironmentSecretBindingV1[], remove: readonly string[] = [], commit = true): EditResult {
        if (!canWrite()) return { ok: false, error: 'unavailable' };
        const { bindings, managedIdentities, onChangeBindings } = current.current;
        const existing = new Map(bindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
        const removed = new Set(remove);
        const changed = new Map<string, EnvironmentSecretBindingV1>();
        for (const binding of set) {
            if (!EnvironmentSecretBindingV1Schema.safeParse(binding).success) return { ok: false, error: 'invalid_binding' };
            const identity = environmentSecretBindingIdentityV1(binding);
            if (changed.has(identity)) return { ok: false, error: 'duplicate_identity' };
            if (managedIdentities?.has(identity)) return { ok: false, error: 'managed' };
            if (!removed.has(identity) && existing.has(identity)) {
                return { ok: false, error: 'duplicate_identity' };
            }
            changed.set(identity, binding);
        }
        for (const identity of removed) {
            if (managedIdentities?.has(identity)) return { ok: false, error: 'managed' };
            if (!existing.has(identity)) return { ok: false, error: 'missing_binding' };
        }
        if (!commit) return ok;
        const next: EnvironmentSecretBindingV1[] = [];
        for (const binding of bindings) {
            const identity = environmentSecretBindingIdentityV1(binding);
            if (!removed.has(identity)) next.push(binding);
            else {
                const replacement = changed.get(identity) ?? (remove.length === 1 && set.length === 1 ? set[0] : undefined);
                if (replacement) {
                    next.push(JSON.stringify(binding) === JSON.stringify(replacement) ? binding : replacement);
                    changed.delete(environmentSecretBindingIdentityV1(replacement));
                }
            }
        }
        next.push(...changed.values());
        if (next.length !== bindings.length || next.some((binding, index) => binding !== bindings[index])) onChangeBindings(next);
        return ok;
    }

    function put(binding: EnvironmentSecretBindingV1, originalIdentity?: string): EditResult {
        return apply([binding], originalIdentity === undefined ? [] : [originalIdentity]);
    }
    function setVariable(input: Readonly<{ name: string; phase: 'build' | 'runtime' | 'both'; source: EnvironmentVariableBindingV1['source']; originalIdentity?: string }>, commit = true): EditResult {
        const phases = input.phase === 'both' ? ['build', 'runtime'] as const : [input.phase];
        return apply(phases.map(phase => ({ purpose: 'variable', name: input.name, phase, source: input.source })),
            input.originalIdentity === undefined ? [] : [input.originalIdentity], commit);
    }
    /** The whole file: every current variable, secrets and other sources as ‹references›, never values. */
    function bulkText(label: EnvironmentBulkSourceLabel = defaultEnvironmentBulkSourceLabel): string {
        const entries = fileEntries(current.current.bindings);
        const width = Math.max(0, ...entries.map(entry => entry.name.length));
        return entries.map(entry => {
            const kept = token(entry.source, label);
            const rhs = kept ?? (entry.source.kind === 'value' ? entry.source.value : '');
            const note = entry.phase === 'build' ? 'build' : entry.phase === 'both' ? 'build + runtime' : null;
            return `${entry.name.padEnd(width)} = ${rhs}${note ? `   # ${note}` : ''}`;
        }).join('\n');
    }
    /**
     * Reads the edited file against the current bindings: a kept ‹reference› stays the same source, a literal
     * is a new value, a missing name is removed. Only the difference is staged; nothing is bound until apply.
     */
    function stageBulk(text: string, phase: 'build' | 'runtime' = 'runtime',
        label: EnvironmentBulkSourceLabel = defaultEnvironmentBulkSourceLabel): EditResult {
        if (!canWrite()) return { ok: false, error: 'unavailable' };
        const bindings = current.current.bindings;
        const variables = bindings.filter((binding): binding is VariableBinding => binding.purpose === 'variable');
        const currentById = new Map(variables.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
        const tokens = new Map<string, VariableSource[]>();
        for (const binding of variables) {
            const kept = token(binding.source, label);
            if (kept === null) continue;
            const list = tokens.get(kept) ?? [];
            if (!list.some(source => sameSource(source, binding.source))) list.push(binding.source);
            tokens.set(kept, list);
        }
        const parsed: Array<{ name: string; phase: BulkPhase; value: string; source: VariableSource | null }> = [];
        const desired = new Set<string>();
        const secretLiterals = new Set<string>();
        for (const line of text.split(/\r?\n/u)) {
            if (!line.trim() || line.trimStart().startsWith('#')) continue;
            const separator = line.indexOf('=');
            if (separator < 0) return { ok: false, error: 'invalid_binding' };
            const name = line.slice(0, separator).trim();
            let rhs = line.slice(separator + 1);
            const note = PHASE_NOTE.exec(rhs);
            const entryPhase: BulkPhase = note ? (note[1] === 'build + runtime' ? 'both' : note[1] as 'build' | 'runtime') : phase;
            if (note) rhs = rhs.slice(0, note.index);
            rhs = rhs.trim();
            let source: VariableSource | null = null;
            let value = rhs;
            if (rhs.startsWith('‹') && rhs.endsWith('›')) {
                const candidates = tokens.get(rhs) ?? [];
                // The name's own source first, so two secrets that read alike stay where they were.
                source = variables.find(binding => binding.name === name && token(binding.source, label) === rhs)?.source
                    ?? (candidates.length === 1 ? candidates[0]! : null);
                if (!source) return { ok: false, error: 'unknown_reference' };
                value = '';
            } else {
                const quoted = /^(["'])(.*)\1$/u.exec(rhs);
                if (quoted) value = quoted[2]!;
            }
            for (const entry of phasesOf(entryPhase)) {
                const binding = { purpose: 'variable' as const, name, phase: entry, source: source ?? { kind: 'value' as const, value } };
                if (!EnvironmentSecretBindingV1Schema.safeParse(binding).success) return { ok: false, error: 'invalid_binding' };
                const identity = environmentSecretBindingIdentityV1(binding);
                if (desired.has(identity)) return { ok: false, error: 'duplicate_identity' };
                desired.add(identity);
            }
            parsed.push({ name, phase: entryPhase, value, source });
        }
        const names = new Set(parsed.map(entry => entry.name));
        const lostIdentity = (name: string) => variables.some(binding => binding.name === name
            && !desired.has(environmentSecretBindingIdentityV1(binding)));
        const rowsOut: BulkRow[] = [];
        const replaced: string[] = [];
        for (const entry of parsed) {
            const identities = phasesOf(entry.phase).map(entryPhase =>
                environmentSecretBindingIdentityV1({ purpose: 'variable', name: entry.name, phase: entryPhase }));
            const was = identities.map(identity => currentById.get(identity));
            const previous = variables.find(binding => binding.name === entry.name)?.source;
            const classification = entry.source ? (entry.source.kind === 'secret' ? 'secret' as const : 'plain' as const)
                : previous ? (previous.kind === 'secret' ? 'secret' as const : 'plain' as const)
                    : SECRET_NAME.test(entry.name) ? 'secret' as const : 'plain' as const;
            const desiredSource: VariableSource | null = entry.source
                ?? (classification === 'plain' ? { kind: 'value', value: entry.value } : null);
            const unchanged = desiredSource !== null && was.every(binding => binding && sameSource(binding.source, desiredSource))
                && !lostIdentity(entry.name);
            if (unchanged) continue;
            if (classification === 'secret' && !entry.source) {
                if (secretLiterals.has(entry.name)) return { ok: false, error: 'duplicate_identity' };
                secretLiterals.add(entry.name);
            }
            replaced.push(...identities.filter(identity => currentById.has(identity)));
            rowsOut.push({ name: entry.name, phase: entry.phase, change: previous ? 'changed' : 'added',
                value: entry.value, source: entry.source, classification });
        }
        const removed = [...new Set(variables.filter(binding => !names.has(binding.name)).map(binding => binding.name))];
        for (const [identity] of currentById) {
            if (!desired.has(identity) && !replaced.includes(identity)) replaced.push(identity);
        }
        publishBulk({ scopeKey, rows: rowsOut, removed, replaced });
        return ok;
    }
    function applyBulk(selections: Readonly<Record<string, SecretSource>>, commit = true): EditResult {
        if (!canWrite()) return { ok: false, error: 'unavailable' };
        if (!staged || currentBulk.current !== bulkState) return { ok: false, error: 'no_draft' };
        const set: EnvironmentSecretBindingV1[] = [];
        for (const row of staged.rows) {
            const selected = Object.hasOwn(selections, row.name) ? selections[row.name] : undefined;
            const source = row.source ?? (row.classification === 'plain' ? { kind: 'value' as const, value: row.value }
                : selected ?? (!commit ? { kind: 'value' as const, value: row.value } : undefined));
            if (!source) return { ok: false, error: 'selection_required' };
            for (const phase of phasesOf(row.phase)) set.push({ purpose: 'variable', name: row.name, phase, source });
        }
        const result = apply(set, staged.replaced, commit);
        if (commit && result.ok && currentBulk.current === bulkState) publishBulk(null);
        return result;
    }
    return { rows, bulk: staged?.rows ?? null, bulkRemoved: staged?.removed ?? null, bulkText,
        bulkInput: available && inputState !== null && inputState.scopeKey === scopeKey ? inputState.value : null,
        setBulkInput: (value: BulkInput) => { if (canWrite()) setInput({ scopeKey, value }); },
        put, putMany: (set: readonly EnvironmentSecretBindingV1[], remove: readonly string[] = []) => apply(set, remove),
        setVariable: (input: Parameters<typeof setVariable>[0]) => setVariable(input), stageBulk,
        applyBulk: (selections: Readonly<Record<string, SecretSource>>) => applyBulk(selections),
        // Creation can check the same destination rules before making a Saved
        // Secret. Validation never publishes raw bulk values into bindings.
        validateVariable: (input: Parameters<typeof setVariable>[0]) => setVariable(input, false),
        validateBulk: (selections: Readonly<Record<string, SecretSource>> = {}) => applyBulk(selections, false),
        remove: (identity: string) => apply([], [identity]),
        cancelBulk: () => {
            if (current.current.scopeKey === scopeKey) { publishBulk(null); setInput(null); }
        },
        classifyBulk: (name: string, classification: BulkRow['classification']) => {
            if (!canWrite()) return;
            const previous = currentBulk.current;
            if (previous !== null && previous.scopeKey === scopeKey
                && previous.rows.some(row => row.name === name && row.source === null && row.classification !== classification)) {
                publishBulk({ ...previous, rows: previous.rows.map(row => row.name === name && row.source === null
                    ? { ...row, classification } : row) });
            }
        },
    };
}
