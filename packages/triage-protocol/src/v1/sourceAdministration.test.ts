import { describe, expect, it } from 'vitest';

import { createTriageSourceV1Fixture } from '../testing/v1/fixtures.js';
import {
    TRIAGE_SOURCES_ADMINISTER_ACTION_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
} from './sourceAdministration.js';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from './bounds.js';

const fixture = createTriageSourceV1Fixture();
const draft = fixture.listInstancesResult.kind === 'complete'
    ? fixture.listInstancesResult.candidates[0]!
    : undefined;
const sourceInstanceId = fixture.configuredInstance.instance.sourceInstanceId;

describe('Triage source administration Action identity', () => {
    it('publishes one exact qualified ref that matches the stable registration id', () => {
        expect(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1).toEqual({
            pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
            localId: TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
        });
        expect(TRIAGE_SOURCES_ADMINISTER_ACTION_ID_V1).toBe(
            `${TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1}/${TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1}`,
        );
        expect(Object.isFrozen(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1)).toBe(true);
    });
});

describe('Triage source administration input', () => {
    it('admits native service metadata without a synthetic account or credential', () => {
        const binding = {
            purpose: 'github-account-use',
            source: 'native',
            service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
        };
        const input = { v: 1, kind: 'create', draft: { ...draft, binding } };
        expect(TriageSourceAdministrationActionInputV1Schema.parse(input)).toEqual(input);
        for (const extra of [{ account: fixture.configuredInstance.binding }, { token: 'secret' }, { credential: 'secret' }]) {
            expect(TriageSourceAdministrationActionInputV1Schema.safeParse({
                ...input, draft: { ...input.draft, binding: { ...binding, ...extra } },
            }).success).toBe(false);
        }
    });

    it('admits exactly the four lifecycle arms', () => {
        expect(draft).toBeDefined();
        for (const input of [
            { v: 1, kind: 'create', draft },
            { v: 1, kind: 'reconfigure', sourceInstanceId, draft },
            { v: 1, kind: 'remove', sourceInstanceId },
            { v: 1, kind: 'reactivate', sourceInstanceId, draft },
        ]) {
            expect(TriageSourceAdministrationActionInputV1Schema.safeParse(input).success).toBe(true);
        }
        expect(TriageSourceAdministrationActionInputV1Schema.safeParse({
            v: 1,
            kind: 'retire',
            sourceInstanceId,
        }).success).toBe(false);
    });

    it('admits a requested source address without accepting caller provenance or confirmation', () => {
        expect(TriageSourceAdministrationActionInputV1Schema.parse({
            v: 1, kind: 'create', draft, source: fixture.configuredInstance.instance.source,
        })).toMatchObject({ source: fixture.configuredInstance.instance.source });
        for (const smuggled of [
            { callerPluginId: 'happier.example.source' },
            { contributionId: 'example-forge' },
            { confirmed: true },
        ]) {
            expect(TriageSourceAdministrationActionInputV1Schema.safeParse({
                v: 1,
                kind: 'remove',
                sourceInstanceId,
                ...smuggled,
            }).success).toBe(false);
        }
    });
});

describe('Triage source administration result', () => {
    it('exposes only the canonical instance id on every success arm', () => {
        for (const kind of ['active', 'reused', 'reconfigured', 'reactivated', 'removed']) {
            expect(TriageSourceAdministrationActionResultV1Schema.parse({ kind, sourceInstanceId }))
                .toEqual({ kind, sourceInstanceId });
        }
        expect(TriageSourceAdministrationActionResultV1Schema.safeParse({
            kind: 'active',
            sourceInstanceId,
            binding: fixture.configuredInstance.binding,
        }).success).toBe(false);
        expect(TriageSourceAdministrationActionResultV1Schema.safeParse({
            kind: 'active',
            sourceInstanceId,
            configuration: fixture.configuredInstance.configuration,
        }).success).toBe(false);
    });

    it('has exactly four closed failure arms and no cancellation arm', () => {
        for (const kind of ['invalidCaller', 'currentnessConflict', 'conflict', 'atMaximum']) {
            expect(TriageSourceAdministrationActionResultV1Schema.parse({ kind })).toEqual({ kind });
        }
        expect(TriageSourceAdministrationActionResultV1Schema.safeParse({ kind: 'cancelled' }).success)
            .toBe(false);
    });
});
