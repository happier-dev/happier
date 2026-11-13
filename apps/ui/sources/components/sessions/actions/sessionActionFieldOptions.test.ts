import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { buildSessionActionFieldOptionsResolver } from './sessionActionFieldOptions';

/**
 * F-4 (2026-08-11) — the SETTING -> painted-option-list half of the action-draft size key. The
 * option-list -> key half lives in
 * `transcript/measurement/actionDraftStatusChurn.consumers.test.ts`.
 *
 * The second test here is the load-bearing one: it pins the invariant that lets the transcript
 * resolve this list from ONE narrow settings subscription and no machine-capabilities snapshot. If a
 * future change makes the snapshot able to add, remove or rename an option — which is exactly what
 * ../dev's `reviewEngineCatalog` does with its `discoveredReviewOptions` block — this test fails, and
 * whoever lands it has to feed the snapshot into `useSessionActionFieldOptionsForRowHeight` instead
 * of shipping a key that is blind to it.
 */
describe('session action field options', () => {
    const label = (agentId: string) => `label:${agentId}`;
    const engineField = { optionsSourceId: 'review.engines.available' } as const;
    const backendField = { optionsSourceId: 'execution.backends.enabled' } as const;

    it('drops an agent chip when the synced setting disables it', () => {
        const both = buildSessionActionFieldOptionsResolver({
            enabledAgentIds: ['codex', 'claude'],
            executionRunsBackends: null,
            resolveAgentLabel: label,
        });
        const onlyCodex = buildSessionActionFieldOptionsResolver({
            enabledAgentIds: ['codex'],
            executionRunsBackends: null,
            resolveAgentLabel: label,
        });

        expect(both(backendField).map((option) => option.value)).toEqual(['codex', 'claude']);
        expect(onlyCodex(backendField).map((option) => option.value)).toEqual(['codex']);
        // The review engines list carries the same agent chips (plus the static native engines).
        expect(both(engineField).length).toBe(onlyCodex(engineField).length + 1);
    });

    it('the capabilities snapshot cannot change a painted option id or label', () => {
        const snapshot = {
            codex: { available: true, intents: ['review', 'plan'] },
            claude: { available: false, intents: ['review'] },
            // A machine-reported backend this app does not know as an agent. ../dev turns this into a
            // whole extra option row; here it must not appear at all.
            'some-unknown-review-backend': { available: true, intents: ['review'] },
        } as const;

        const withoutSnapshot = buildSessionActionFieldOptionsResolver({
            enabledAgentIds: ['codex', 'claude'],
            executionRunsBackends: null,
            resolveAgentLabel: label,
        });
        const withSnapshot = buildSessionActionFieldOptionsResolver({
            enabledAgentIds: ['codex', 'claude'],
            executionRunsBackends: snapshot,
            resolveAgentLabel: label,
        });

        for (const field of [engineField, backendField]) {
            expect(withSnapshot(field).map((option) => ({ value: option.value, label: option.label })))
                .toEqual(withoutSnapshot(field).map((option) => ({ value: option.value, label: option.label })));
        }
        // ...and the snapshot IS doing something, so this is not a vacuous comparison: it disables the
        // unavailable agent. That flag is the only channel it has, and it is not height-bearing.
        expect(withSnapshot(engineField).some((option) => option.disabled === true)).toBe(true);
        expect(withoutSnapshot(engineField).some((option) => option.disabled === true)).toBe(false);
    });

    it('passes a field with static options straight through', () => {
        const resolve = buildSessionActionFieldOptionsResolver({
            enabledAgentIds: ['codex'],
            executionRunsBackends: null,
            resolveAgentLabel: label,
        });
        const options = resolve({
            options: [{ value: 'all', label: 'All changes' }, { value: '', label: 'dropped' }],
        } as never);
        expect(options).toEqual([{ value: 'all', label: 'All changes' }]);
    });

    it('refreshes a mounted role field when the active account catalog changes', async () => {
        const { SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1 } = await import('@happier-dev/protocol');
        const { storage } = await import('@/sync/domains/state/storage');
        const { useSessionActionFieldOptionsForRowHeight } = await import('./useSessionActionFieldOptions');
        const originalProfiles = storage.getState().settings.sessionRoleProfilesV1;
        const architectId = 'custom:123e4567-e89b-12d3-a456-426614174000' as const;
        const researcherId = 'custom:223e4567-e89b-12d3-a456-426614174000' as const;
        const roleField = { optionsSourceId: 'session.roles.assignable_or_clear' } as const;

        storage.setState((state) => ({ ...state, settings: { ...state.settings,
            sessionRoleProfilesV1: { v: 1, instructionsByRole: {}, customRoles: [
                { id: architectId, name: 'Architect', instructions: 'Design.', color: '#123456' },
                SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
            ] },
        } }));

        try {
            const hook = await renderHook(() => useSessionActionFieldOptionsForRowHeight('mounted-session'));
            expect(hook.getCurrent()(roleField).map((option) => option.value)).toEqual([
                SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.id,
                'project_lead',
                'planner',
                'worker',
                'reviewer',
                architectId,
                'none',
            ]);

            await act(async () => {
                storage.setState((state) => ({ ...state, settings: { ...state.settings,
                    sessionRoleProfilesV1: { v: 1, instructionsByRole: {}, customRoles: [
                        { id: researcherId, name: 'Researcher', instructions: 'Research.', color: '#654321' },
                    ] },
                } }));
            });
            await hook.rerender();

            const labels = hook.getCurrent()(roleField).map((option) => option.label);
            expect(labels).toContain('Researcher');
            expect(labels).not.toContain('Architect');
        } finally {
            await act(async () => {
                storage.setState((state) => ({ ...state, settings: { ...state.settings,
                    sessionRoleProfilesV1: originalProfiles,
                } }));
            });
        }
    });
});
