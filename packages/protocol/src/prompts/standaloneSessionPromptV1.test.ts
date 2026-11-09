import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { buildCodingSessionPromptPlanBaseV1 } from './buildAppendSystemPromptBaseV1.js';
import {
    applyStandaloneSessionPromptSnapshotV1ToMetadata,
    buildStandaloneSessionPromptBlockTextV1,
    buildStandaloneSessionPromptSnapshotV1,
    readStandaloneSessionPromptSnapshotV1,
} from './standaloneSessionPromptV1.js';

const settings = { standaloneSessionPromptV1: { v: 1, text: '  Be brief and practical.  ', updatedAt: 42 } };

describe('standaloneSessionPromptV1', () => {
    it('ships empty and is lenient', () => {
        expect(accountSettingsParse({}).standaloneSessionPromptV1).toEqual({ v: 1, text: '' });
        expect(accountSettingsParse({ standaloneSessionPromptV1: { v: 1, text: 7 } }).standaloneSessionPromptV1).toEqual({ v: 1, text: '' });
    });

    it('snapshots non-blank text only for a fresh roleless session', () => {
        expect(buildStandaloneSessionPromptSnapshotV1({ settings, metadata: {} })).toEqual({ v: 1, text: 'Be brief and practical.', sourceUpdatedAt: 42 });
        expect(buildStandaloneSessionPromptSnapshotV1({ settings: {}, metadata: {} })).toBeNull();
        expect(buildStandaloneSessionPromptSnapshotV1({ settings, metadata: { sessionRoleV1: { v: 1, role: 'worker' } } })).toBeNull();
    });

    it('renders from metadata, and a later role assignment removes it without rewriting the snapshot', () => {
        const snapshot = buildStandaloneSessionPromptSnapshotV1({ settings, metadata: {} })!;
        const metadata = applyStandaloneSessionPromptSnapshotV1ToMetadata({}, snapshot);
        expect(readStandaloneSessionPromptSnapshotV1(metadata)).toEqual(snapshot);
        expect(buildStandaloneSessionPromptBlockTextV1(metadata)).toBe('Be brief and practical.');
        const assigned = { ...metadata, sessionRoleV1: { v: 1, role: 'reviewer', instructions: 'Review.' } };
        expect(buildStandaloneSessionPromptBlockTextV1(assigned)).toBeNull();
        expect(readStandaloneSessionPromptSnapshotV1(assigned)).toEqual(snapshot);
    });

    it('adds coding.standalone_default from metadata even when the shared builder runs without settings', () => {
        const metadata = applyStandaloneSessionPromptSnapshotV1ToMetadata({}, { v: 1, text: 'Personal default.' });
        const plan = buildCodingSessionPromptPlanBaseV1({ settings: null, executionRunsFeatureEnabled: false, sessionMetadata: metadata });
        expect(plan.blocks.map((block) => block.id)).toEqual(['coding.base', 'coding.standalone_default']);
        expect(plan.blocks[1]).toEqual({ id: 'coding.standalone_default', scope: 'session', text: 'Personal default.' });

        const assigned = { ...metadata, sessionRoleV1: { v: 1, role: 'reviewer', instructions: 'Review.' } };
        const assignedPlan = buildCodingSessionPromptPlanBaseV1({ settings: null, executionRunsFeatureEnabled: false, sessionMetadata: assigned });
        expect(assignedPlan.blocks.map((block) => block.id)).toEqual(['coding.base', 'coding.session_role']);
    });
});
