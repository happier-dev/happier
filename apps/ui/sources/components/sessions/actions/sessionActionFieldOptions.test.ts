import { describe, expect, it } from 'vitest';
import type { ActionInputFieldHint } from '@happier-dev/protocol';

import {
    buildSessionActionFieldOptionLists,
    buildSessionActionFieldOptionsHeightSignature,
    buildSessionActionFieldOptionsResolver,
} from './sessionActionFieldOptions';

/**
 * F-4 (2026-08-11) — the INPUTS -> painted-option-list half of the action-draft size key. The
 * option-list -> key half lives in
 * `transcript/measurement/actionDraftStatusChurn.consumers.test.ts`.
 *
 * The second and third tests are the load-bearing ones, and they are exactly where this repo differs
 * from remote-dev: there, the async machine-capabilities snapshot can only flip an option's
 * `disabled` flag, so the transcript resolves the list from one settings subscription and ignores the
 * snapshot entirely. Here `buildAvailableReviewEngineOptions` ADDS one option per machine-reported
 * review-capable backend and prefers the snapshot's own title as the label, so the snapshot is
 * height-bearing and the transcript has to take it — while still holding one resolver identity across
 * the churn that only moves `disabled`.
 */
describe('session action field options', () => {
    const label = (agentId: string) => `label:${agentId}`;
    const engineField = { optionsSourceId: 'review.engines.available' } as const;
    const backendField = { optionsSourceId: 'execution.backends.enabled' } as const;

    const resolverFor = (params: Parameters<typeof buildSessionActionFieldOptionLists>[0]) =>
        buildSessionActionFieldOptionsResolver(buildSessionActionFieldOptionLists(params));

    it('drops an agent option when the synced setting disables it', () => {
        const both = resolverFor({ enabledAgentIds: ['codex', 'claude'], executionRunsBackends: null, resolveAgentLabel: label });
        const onlyCodex = resolverFor({ enabledAgentIds: ['codex'], executionRunsBackends: null, resolveAgentLabel: label });

        expect(both(backendField).map((option) => option.label)).toEqual(['label:codex', 'label:claude']);
        expect(onlyCodex(backendField).map((option) => option.label)).toEqual(['label:codex']);
        expect(both(engineField).length).toBe(onlyCodex(engineField).length + 1);
    });

    it('the capabilities snapshot adds a whole option row and renames an existing one', () => {
        const snapshot = {
            codex: { available: true, intents: ['review', 'plan'], title: 'Codex (machine)' },
            // A machine-reported backend this app does not know as an agent. remote-dev's catalog
            // cannot surface this at all; here it is a whole extra `HappierSelect` row.
            'some-unknown-review-backend': { available: true, intents: ['review'], title: 'Vendor Review' },
        } as const;

        const withoutSnapshot = resolverFor({ enabledAgentIds: ['codex'], executionRunsBackends: null, resolveAgentLabel: label });
        const withSnapshot = resolverFor({ enabledAgentIds: ['codex'], executionRunsBackends: snapshot, resolveAgentLabel: label });

        expect(withoutSnapshot(engineField).map((option) => option.label)).toEqual(['label:codex']);
        // Both channels at once: one added row, and the surviving row renamed.
        expect(withSnapshot(engineField).map((option) => option.label)).toEqual(['Codex (machine)', 'Vendor Review']);
    });

    it('the height signature ignores availability and nothing else', () => {
        const base = { enabledAgentIds: ['codex', 'claude'], resolveAgentLabel: label } as const;
        const available = buildSessionActionFieldOptionLists({
            ...base,
            executionRunsBackends: { codex: { available: true, intents: ['review'] }, claude: { available: true, intents: ['review'] } },
        });
        const oneUnavailable = buildSessionActionFieldOptionLists({
            ...base,
            executionRunsBackends: { codex: { available: true, intents: ['review'] }, claude: { available: false, intents: ['review'] } },
        });
        const renamed = buildSessionActionFieldOptionLists({
            ...base,
            executionRunsBackends: { codex: { available: true, intents: ['review'], title: 'Codex Pro' }, claude: { available: true, intents: ['review'] } },
        });

        // The snapshot IS doing something, so the comparison below is not vacuous.
        expect(oneUnavailable.engineOptions.some((option) => option.disabled === true)).toBe(true);
        expect(available.engineOptions.some((option) => option.disabled === true)).toBe(false);

        // V-3 (2026-08-11): fed the RAW lists, `disabled` and all. The signature is the only owner of
        // the height-bearing/not distinction, so it has to survive that on its own — a pre-strip that
        // rebuilt the lists without `disabled` first was a no-op in front of this and is gone.
        const signature = buildSessionActionFieldOptionsHeightSignature;
        expect(signature(oneUnavailable)).toBe(signature(available));
        expect(signature(renamed)).not.toBe(signature(available));
    });

    it('preserves static option presentation state from the normalized descriptor', () => {
        const resolve = resolverFor({ enabledAgentIds: ['codex'], executionRunsBackends: null, resolveAgentLabel: label });
        const field: Pick<ActionInputFieldHint, 'options'> = {
            options: [
                {
                    value: 'all',
                    label: 'All changes',
                    description: 'Review every changed file.',
                },
                { value: 'draft', label: 'Draft only', disabled: true },
            ],
        };
        const options = resolve(field);
        expect(options).toEqual([
            {
                value: 'all',
                label: 'All changes',
                description: 'Review every changed file.',
            },
            { value: 'draft', label: 'Draft only', disabled: true },
        ]);
    });
});
