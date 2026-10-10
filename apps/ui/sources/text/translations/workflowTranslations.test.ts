import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    WORKFLOW_INVOCATION_LIFECYCLES_V1,
    WORKFLOW_RUN_STATES_V1,
    WORKFLOW_VALIDATION_ISSUE_CODES,
} from '@happier-dev/protocol';

import { workflowTranslations } from './workflowTranslations';

/**
 * Shape guards for the workflow copy owner.
 *
 * Two failure modes have already happened here and neither is visible by
 * reading the file: a duplicate key in an object literal silently overwrites
 * the earlier entry, and a locale group can drift out of step with the closed
 * Protocol union it is supposed to label. Both are checked structurally against
 * the canonical unions rather than against a hand-listed expectation, so this
 * test keeps working as those unions evolve.
 */

const SOURCE_PATH = fileURLToPath(new URL('./workflowTranslations.ts', import.meta.url));
const LOCALES = Object.keys(workflowTranslations) as Array<keyof typeof workflowTranslations>;

/**
 * Extra `runState` entries that are deliberately not parent Run states: the
 * announcement and outcome-composition owners label these, and they have no
 * member in `WORKFLOW_RUN_STATES_V1`.
 */
const NON_UNION_RUN_STATE_KEYS = ['pending', 'cancel_requested', 'completed', 'completed_with_failures'] as const;

/** The canonical issue presenter names specific repairs without inventing wire issue codes. */
const ISSUE_PRESENTATION_KEYS = ['emptyPrompt', 'emptyWaitPrompt', 'fieldMissing', 'fieldInvalid'] as const;

type DuplicateKey = Readonly<{ scope: string; key: string; lines: readonly number[] }>;

/**
 * Reports keys declared more than once inside the same object literal. This is
 * a source-level check on purpose: by the time the module is imported the
 * duplicate has already been collapsed and is undetectable at runtime.
 */
function findDuplicateKeys(source: string): readonly DuplicateKey[] {
    const lines = source.split('\n');
    const stack: Array<Readonly<{ name: string; keys: Map<string, number[]> }>> = [];
    const duplicates: DuplicateKey[] = [];

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const trimmed = line.trim();
        const opening = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{\s*$/.exec(trimmed);
        if (opening !== null) {
            stack[stack.length - 1]?.keys.set(
                opening[1]!,
                [...(stack[stack.length - 1]?.keys.get(opening[1]!) ?? []), lineNumber],
            );
            stack.push({ name: opening[1]!, keys: new Map() });
            return;
        }
        const entry = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
        if (entry !== null && stack.length > 0) {
            const scope = stack[stack.length - 1]!;
            scope.keys.set(entry[1]!, [...(scope.keys.get(entry[1]!) ?? []), lineNumber]);
        }
        if (trimmed.startsWith('}') && stack.length > 0) {
            const scope = stack.pop()!;
            for (const [key, occurrences] of scope.keys) {
                if (occurrences.length > 1) {
                    duplicates.push({ scope: scope.name, key, lines: occurrences });
                }
            }
        }
    });
    return duplicates;
}

describe('workflow translations shape', () => {
    it('declares every key exactly once, so no entry is silently overwritten', () => {
        const duplicates = findDuplicateKeys(readFileSync(SOURCE_PATH, 'utf8'));
        expect(duplicates).toEqual([]);
    });

    it('detects a duplicate when one is present, so the guard cannot pass vacuously', () => {
        const withDuplicate = [
            'const en = {',
            '    runState: {',
            "        queued: 'first',",
            "        claimed: 'other',",
            "        queued: 'second',",
            '    },',
            '};',
        ].join('\n');
        expect(findDuplicateKeys(withDuplicate)).toEqual([
            { scope: 'runState', key: 'queued', lines: [3, 5] },
        ]);
    });

    it('covers every locale the module exports', () => {
        expect(LOCALES).toContain('en');
        expect(LOCALES.length).toBe(12);
    });

    for (const locale of LOCALES) {
        describe(`locale ${String(locale)}`, () => {
            const group = workflowTranslations[locale];

            it('labels exactly the canonical parent Run states plus the retained outcome keys', () => {
                expect(new Set(Object.keys(group.runState)))
                    .toEqual(new Set([...WORKFLOW_RUN_STATES_V1, ...NON_UNION_RUN_STATE_KEYS]));
            });

            it('labels exactly the canonical invocation lifecycle, kept distinct from runState', () => {
                expect(new Set(Object.keys(group.invocationState)))
                    .toEqual(new Set(WORKFLOW_INVOCATION_LIFECYCLES_V1));
            });

            it('labels every closed validation issue code and the issue presenter’s specific repairs', () => {
                expect(new Set(Object.keys(group.issue)))
                    .toEqual(new Set([...WORKFLOW_VALIDATION_ISSUE_CODES, ...ISSUE_PRESENTATION_KEYS]));
            });

            it('gives runState and invocationState their own wording for shared member names', () => {
                // `pending`, `running`, `failed`, `cancelled`, `skipped` and
                // `outcome_uncertain` exist in both unions but describe a whole
                // Run versus one step, so they are separate keys by design.
                const shared = Object.keys(group.runState)
                    .filter((key) => key in group.invocationState);
                expect(shared.length).toBeGreaterThan(0);
                for (const key of shared) {
                    expect(typeof group.runState[key as keyof typeof group.runState]).toBe('string');
                    expect(typeof group.invocationState[key as keyof typeof group.invocationState]).toBe('string');
                }
            });

            it('leaves no label empty', () => {
                for (const [key, value] of Object.entries({ ...group.runState, ...group.invocationState })) {
                    expect(value, `${String(locale)}.${key}`).not.toBe('');
                }
            });
        });
    }
});
