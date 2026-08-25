import { describe, expect, it } from 'vitest';

import { createTriageSourceV1Fixture } from '../testing/v1/fixtures.js';
import { TriageEntryRefV1Schema } from './identity.js';
import {
    TriageEntryRepositoryRefV1Schema,
    TriageRowFactV1Schema,
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceObservationV1Schema,
    TriageSourceScanEvidenceV1Schema,
    TriageSourceScanObservationV1Schema,
    TriageSourceViewerFactsV1Schema,
} from './observations.js';

const fixture = createTriageSourceV1Fixture();
const present = fixture.getResult;
const localRef = { kindId: 'pull-request', collisionScope: 'example:41231', entryId: '17' };

describe('Triage entry repository identity', () => {
    it('keeps forge identity out of the closed canonical entry ref', () => {
        expect(TriageEntryRefV1Schema.safeParse({
            source: { pluginId: 'happier.scm.forge.github', localId: 'github' },
            ...localRef,
            repository: {
                kind: 'github',
                deployment: 'https://github.com',
                repository: 'acme/app',
            },
        }).success).toBe(false);
    });

    it('admits the longest repository path each shipped forge can produce', () => {
        const longestByForge = {
            github: `${'o'.repeat(39)}/${'r'.repeat(100)}`,
            gitlab: `${'g'.repeat(154)}/${'r'.repeat(100)}`,
            bitbucket: `${'w'.repeat(62)}/${'r'.repeat(62)}`,
            azureDevOps: `${'o'.repeat(64)}/${'p'.repeat(64)}/${'r'.repeat(64)}`,
        } as const;

        expect(Object.fromEntries(Object.entries(longestByForge).map(([forge, nameWithOwner]) => [
            forge,
            {
                bytes: new TextEncoder().encode(nameWithOwner).byteLength,
                admitted: TriageEntryRepositoryRefV1Schema.safeParse({
                    kind: forge === 'azureDevOps' ? 'azure-devops' : forge,
                    deployment: 'https://example.test',
                    repository: nameWithOwner,
                }).success,
            },
        ]))).toEqual({
            github: { bytes: 140, admitted: true },
            gitlab: { bytes: 255, admitted: true },
            bitbucket: { bytes: 125, admitted: true },
            azureDevOps: { bytes: 194, admitted: true },
        });

        expect(TriageEntryRepositoryRefV1Schema.safeParse({
            kind: 'github',
            deployment: 'https://example.test',
            repository: 'r'.repeat(256),
        }).success).toBe(false);

        expect(TriageEntryRepositoryRefV1Schema.safeParse({
            hostingProviderId: 'happier.scm.forge.github/github',
            deployment: 'https://github.com',
            nameWithOwner: 'acme/app',
        }).success).toBe(false);
    });
});

describe('Triage source observation union', () => {
    it('serializes absence as exactly kind and localRef', () => {
        expect(TriageSourceObservationV1Schema.parse({ kind: 'absent', localRef }))
            .toEqual({ kind: 'absent', localRef });
        // A second public absence authority is exactly what CONTRACT.md §4 forbids.
        expect(TriageSourceObservationV1Schema.safeParse({
            kind: 'absent',
            localRef,
            corroboration: ['readableRepository'],
        }).success).toBe(false);
    });

    it('keeps a merged arm to its immediate successor with no recovery envelope', () => {
        const successor = { ...localRef, entryId: '18' };
        expect(TriageSourceObservationV1Schema.parse({ kind: 'merged', localRef, successor }))
            .toEqual({ kind: 'merged', localRef, successor });
        expect(TriageSourceObservationV1Schema.safeParse({
            kind: 'merged',
            localRef,
            successor,
            recovery: { kind: 'unavailableSuccessor' },
        }).success).toBe(false);
    });

    it('excludes absence from the scan-safe union', () => {
        expect(TriageSourceScanObservationV1Schema.safeParse({ kind: 'absent', localRef }).success)
            .toBe(false);
        expect(TriageSourceScanObservationV1Schema.safeParse(present).success).toBe(true);
    });

    it('makes every target-stamped fact unrepresentable in a source observation', () => {
        for (const targetField of [
            { observedAtMs: 1_760_000_000_000 },
            { sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
            { source: { pluginId: 'happier.example.source', localId: 'example-forge' } },
            { entryRef: { ...localRef, source: { pluginId: 'p', localId: 'l' } } },
        ]) {
            expect(TriageSourceObservationV1Schema.safeParse({ ...present, ...targetField }).success)
                .toBe(false);
        }
    });
});

describe('Triage snapshot and row facts', () => {
    it('drops an unknown outer presentation field but rejects an unknown known-child field', () => {
        const parsed = TriageSourceEntrySnapshotV1Schema.parse({
            ...present.snapshot,
            futurePresentationHint: 'ignored',
        });
        expect(parsed).not.toHaveProperty('futurePresentationHint');
        expect(parsed.title).toBe(present.snapshot.title);

        expect(TriageSourceEntrySnapshotV1Schema.safeParse({
            ...present.snapshot,
            state: { presentation: 'active', nativeLabel: 'Open', rawProviderState: 'open' },
        }).success).toBe(false);
    });

    it('keeps presentation "unknown" a valid present state', () => {
        expect(TriageSourceEntrySnapshotV1Schema.safeParse({
            ...present.snapshot,
            state: { presentation: 'unknown', nativeLabel: 'Pending merge' },
        }).success).toBe(true);
        expect(TriageSourceEntrySnapshotV1Schema.safeParse({
            ...present.snapshot,
            state: { presentation: 'done' },
        }).success).toBe(false);
    });

    it('accepts only the six closed row-fact value arms', () => {
        for (const value of [
            { kind: 'text', value: 'x' },
            { kind: 'actor', value: 'octocat' },
            { kind: 'timestamp', atMs: 1, format: 'relative' },
            { kind: 'number', value: 12, format: 'compact', approximate: true },
            { kind: 'status', value: 'All passing', tone: 'success' },
            { kind: 'detailOnly' },
        ]) {
            expect(TriageRowFactV1Schema.safeParse({
                id: 'example/fact',
                importance: 'primary',
                value,
            }).success).toBe(true);
        }
        for (const value of [
            { kind: 'html', value: '<b>x</b>' },
            { kind: 'text', value: 'x', href: 'https://example.test' },
            { kind: 'detailOnly', value: 'x' },
        ]) {
            expect(TriageRowFactV1Schema.safeParse({
                id: 'example/fact',
                importance: 'primary',
                value,
            }).success).toBe(false);
        }
    });
});

describe('Triage viewer facts', () => {
    it('admits only canonical involvement, never a raw native lane token', () => {
        expect(TriageSourceViewerFactsV1Schema.safeParse({
            involvement: ['reviewRequested', 'mentioned'],
        }).success).toBe(true);
        expect(TriageSourceViewerFactsV1Schema.safeParse({
            involvement: ['review-requested'],
        }).success).toBe(false);
        expect(TriageSourceViewerFactsV1Schema.safeParse({
            involvement: ['probed_unsupported'],
        }).success).toBe(false);
    });

    it('cannot express a reasonless attention winner', () => {
        expect(TriageSourceViewerFactsV1Schema.safeParse({
            involvement: [],
            sourceAttention: { level: 'none' },
        }).success).toBe(true);
        expect(TriageSourceViewerFactsV1Schema.safeParse({
            involvement: [],
            sourceAttention: { level: 'required' },
        }).success).toBe(false);
        expect(TriageSourceViewerFactsV1Schema.safeParse({
            involvement: [],
            sourceAttention: { level: 'none', reasonId: 'x', reasonLabel: 'X' },
        }).success).toBe(false);
    });

    it('carries no cached mutation authority', () => {
        for (const cached of [{ canComment: true }, { canMerge: true }, { canMutate: true }]) {
            expect(TriageSourceViewerFactsV1Schema.safeParse({
                involvement: [],
                ...cached,
            }).success).toBe(false);
        }
    });
});

describe('Triage scan evidence', () => {
    it('bounds omitted item counts to the partial arm only', () => {
        expect(TriageSourceScanEvidenceV1Schema.safeParse({
            kind: 'partial',
            reason: 'example-malformed-row',
            omittedItemCount: 3,
        }).success).toBe(true);
        expect(TriageSourceScanEvidenceV1Schema.safeParse({
            kind: 'walkFinished',
            omittedItemCount: 3,
        }).success).toBe(false);
        expect(TriageSourceScanEvidenceV1Schema.safeParse({
            kind: 'moving',
            reason: 'example-window-moved',
            omittedItemCount: 3,
        }).success).toBe(false);
    });

    it('has no fourth health arm', () => {
        expect(TriageSourceScanEvidenceV1Schema.safeParse({ kind: 'complete' }).success).toBe(false);
    });
});

describe('Triage identity and display strings', () => {
    /**
     * The unit separator is the one control character V1 admits, and only inside
     * `collisionScope`: a first-party composite key really contains it
     * (`CONTRACT.md` §6 maps Sentry to `origin U+001F organizationId`), it is a
     * structural key no surface renders, and its small bound can pay the
     * sixfold JSON escaping it costs.
     */
    const UNIT_SEPARATOR = String.fromCodePoint(0x1f);
    const sentryScope = `https://us.sentry.io${UNIT_SEPARATOR}4503599627370496`;

    it('admits the source-owned composite-key separator inside a collision scope', () => {
        const parsed = TriageSourceObservationV1Schema.safeParse({
            ...present,
            localRef: { ...localRef, collisionScope: sentryScope },
        });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.localRef.collisionScope).toBe(sentryScope);
    });

    it('admits at most one separator, so the sixfold expansion stays bounded', () => {
        expect(TriageSourceObservationV1Schema.safeParse({
            ...present,
            localRef: {
                ...localRef,
                collisionScope: `https://us.sentry.io${UNIT_SEPARATOR}450${UNIT_SEPARATOR}17`,
            },
        }).success).toBe(false);
        // A separator needs a component on each side; it is not a prefix, a
        // suffix, or the whole key.
        for (const scope of [
            UNIT_SEPARATOR,
            `${UNIT_SEPARATOR}4503599627370496`,
            `https://us.sentry.io${UNIT_SEPARATOR}`,
        ]) {
            expect(TriageSourceObservationV1Schema.safeParse({
                ...present,
                localRef: { ...localRef, collisionScope: scope },
            }).success).toBe(false);
        }
    });

    it('admits no other control character, including inside a collision scope', () => {
        for (const codePoint of [0x00, 0x09, 0x0a, 0x1e, 0x7f]) {
            expect(TriageSourceObservationV1Schema.safeParse({
                ...present,
                localRef: {
                    ...localRef,
                    collisionScope: `example${String.fromCodePoint(codePoint)}41231`,
                },
            }).success).toBe(false);
        }
    });

    it('keeps every other identifier and display string single-line', () => {
        const lineFeed = String.fromCodePoint(0x0a);
        for (const overridden of [
            { localRef: { ...localRef, entryId: `17${UNIT_SEPARATOR}18` } },
            { localRef: { ...localRef, kindId: `pull${UNIT_SEPARATOR}request` } },
            { nativeRevision: `b3f1${UNIT_SEPARATOR}c0a9` },
            { snapshot: { ...present.snapshot, title: `Replace${UNIT_SEPARATOR}it` } },
            { snapshot: { ...present.snapshot, title: `Replace${lineFeed}it` } },
            { locator: { ...present.locator, webUrl: `https://example.test/a${lineFeed}b` } },
        ]) {
            expect(TriageSourceObservationV1Schema.safeParse({ ...present, ...overridden }).success)
                .toBe(false);
        }
    });
});
