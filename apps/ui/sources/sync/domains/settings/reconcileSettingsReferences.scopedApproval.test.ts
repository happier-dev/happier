import { describe, expect, it } from 'vitest';
import type { ActionScopedApprovalPreferenceV1 } from '@happier-dev/protocol/actions/actionSettings';
import { settingsParse } from './settings';
import { reconcileSettingsReferences } from './reconcileSettingsReferences';

describe('scoped approval Settings references', () => {
    it('retains the unchanged keyed row through a sibling edit and removal', () => {
        const row = { actionId: 'session.stop', scope: { kind: 'machine', machineId: 'A' },
            approvalRequiredSurfaces: ['agent'], approvalWaivedSurfaces: [] } satisfies ActionScopedApprovalPreferenceV1;
        const sibling = { ...row, scope: { kind: 'environment', environmentId: 'B' } } satisfies ActionScopedApprovalPreferenceV1;
        const parse = (rows: readonly ActionScopedApprovalPreferenceV1[]) => settingsParse({ actionsSettingsV1: {
            v: 1, actions: {}, scopedApprovalPreferences: rows,
        } });
        const previous = parse([row, sibling]);
        const originalSibling = previous.actionsSettingsV1.scopedApprovalPreferences?.[1];
        const changed = reconcileSettingsReferences(previous,
            parse([{ ...row, approvalRequiredSurfaces: ['agent', 'cli'] }, sibling]));
        expect(changed.actionsSettingsV1.scopedApprovalPreferences?.[0])
            .not.toBe(previous.actionsSettingsV1.scopedApprovalPreferences?.[0]);
        expect(changed.actionsSettingsV1.scopedApprovalPreferences?.[1]).toBe(originalSibling);
        const removed = reconcileSettingsReferences(changed, parse([sibling]));
        expect(removed.actionsSettingsV1.scopedApprovalPreferences?.[0]).toBe(originalSibling);
        expect(reconcileSettingsReferences(removed, parse([sibling]))).toBe(removed);
    });
});
