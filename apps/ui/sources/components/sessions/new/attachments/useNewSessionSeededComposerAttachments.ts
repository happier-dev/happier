import {
    buildQualifiedPluginContributionKey,
    type ComposerRefV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import {
    createComposerPresentationTransactionApplier,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { ComposerAttachmentAvailabilityCatalog } from '@/components/sessions/composer/composerScopeAdapters';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { NewSessionPluginAttachmentSeedV1 } from '@/utils/sessions/tempDataStore';

/**
 * Places the attachments a plugin seeded this New Session draft with, once its
 * real composer is mounted.
 *
 * This is where the seed's missing half is resolved, and it is deliberately
 * here rather than at the seeding caller: the qualified contribution identity,
 * the host-resolved type label, the cardinality upsert and the host-minted
 * instance id all come from the daemon projection for the machine this draft is
 * pointed at, and only a mounted composer target has one. The transaction goes
 * through the SAME authority-bound applier a live plugin composer control uses
 * (`createComposerPresentationTransactionApplier`), so a seeded attachment and
 * an attachment the reader added through the plugin's own control are the same
 * record, admitted by the same rule.
 *
 * After this the screen's canonical snapshot owns every edit and the send. The
 * seed holds nothing, and the plugin keeps no parallel draft.
 *
 * A seed whose contribution the current projection does not admit is KEPT
 * PENDING rather than dropped: the machine selection is still the reader's to
 * change, and discarding it would open a New Session missing entries the reader
 * explicitly chose with nothing said about it.
 */
export function useNewSessionSeededComposerAttachments(params: Readonly<{
    /**
     * The one-shot host handoff held by this mounted New Session screen. It is
     * never persisted as a draft record; accepted requests disappear from this
     * hook as the canonical composer transaction mints their records.
     */
    seeds: readonly NewSessionPluginAttachmentSeedV1[];
    ref: ComposerRefV1;
    /** The exact current daemon projection for this draft's machine/account scope. */
    entriesById: ComposerAttachmentAvailabilityCatalog['entriesById'];
    /** The projection-bound resolver used by ordinary mounted attachment admission. */
    localize: PluginLocalizedTextResolver;
    isCurrent: () => boolean;
}>): void {
    const { ref, entriesById, seeds } = params;
    const isCurrentRef = React.useRef(params.isCurrent);
    isCurrentRef.current = params.isCurrent;
    const seedSignature = JSON.stringify(seeds);
    const pendingRef = React.useRef<Readonly<{
        signature: string;
        seeds: readonly NewSessionPluginAttachmentSeedV1[];
    }> | null>(null);
    if (pendingRef.current?.signature !== seedSignature) {
        pendingRef.current = Object.freeze({
            signature: seedSignature,
            seeds: Object.freeze([...seeds]),
        });
    }

    React.useEffect(() => {
        if (!isCurrentRef.current()) return;
        const pending = pendingRef.current?.seeds ?? [];
        if (pending.length === 0) return;
        const catalog = entriesById ?? {};
        const applier = createComposerPresentationTransactionApplier({
            composerAttachmentsById: catalog,
            localize: params.localize,
        });

        const applied: NewSessionPluginAttachmentSeedV1[] = [];
        for (const seed of pending) {
            const entry = catalog[buildQualifiedPluginContributionKey({
                pluginId: seed.pluginId,
                localId: seed.attachmentLocalId,
            })];
            // Not admitted here yet. The applier would refuse it anyway; asking
            // it would only turn "wait for the projection" into "refused".
            if (!entry) continue;
            const snapshot = readComposerPresentationSnapshot(ref);
            if (!snapshot) break;
            const result = applier.apply({
                ref,
                admittedContributor: {
                    identity: { pluginId: seed.pluginId, localId: seed.attachmentLocalId },
                    immutableGenerationId: entry.immutableGenerationId,
                },
                transaction: {
                    // Re-read per operation: each applied attachment advances
                    // the document, so a revision captured once would make
                    // every attachment after the first a stale-revision refusal.
                    expectedRevision: snapshot.revision,
                    operations: [{
                        kind: 'attachment.add',
                        attachmentLocalId: seed.attachmentLocalId,
                        value: seed.value,
                    }],
                },
            });
            if (result.status === 'applied') applied.push(seed);
        }
        if (applied.length > 0) {
            pendingRef.current = Object.freeze({
                signature: seedSignature,
                seeds: Object.freeze(pending.filter((seed) => !applied.includes(seed))),
            });
        }
    }, [entriesById, params.localize, ref, seedSignature]);
}
